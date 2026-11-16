package main

import (
	"fmt"
	"log"
	"sort"
	"strings"
	"sync"
)

// Marcas anónimas de entrega por sesión (feedback do calendario do alumnado).
//
// O calendario do alumnado amosa, en cada sesión pasada, un punto verde se el entregou
// e un punto vermello intermitente se non — pero SÓ se algún compañeiro entregou algo
// nesa sesión: se ninguén entregou, iso é que non había tarefa e non se amosa nada (ver
// App.tsx). Un alumno non pode (nin debe) ler os cartafoles dos compañeiros, así que
// cada alumno deixa no cartafol compartido unha marca ANÓNIMA por sesión entregada:
//
//	dixitalizacion/entregas/<materia>/<YYYY-MM-DD>.ok
//
// A marca non leva nome nin contido que identifique a ninguén: só di "nesta sesión
// alguén entregou". Non hai lectura-modificación-escritura dun ficheiro común (cada
// sesión é un ficheiro), así que dous alumnos marcando á vez nunca se pisan.
//
// Entregar = o mesmo criterio do informe de seguimento (SeguimentoAlumno.tsx): escribir
// a práctica da sesión ou subir ficheiros de traballo a ela. As marcas créanse desde o
// frontend do alumno co que xa ten cargado (MarcarEntregas), tamén as das entregas
// anteriores a esta versión: cada alumno que entra completa as que falten.

// fbEntregasRoot é o subcartafol do compartido que garda as marcas de entrega.
const fbEntregasRoot = "entregas"

const marcaEntregaExt = ".ok"

// entregasDir devolve o cartafol compartido coas marcas de entrega dunha materia.
func entregasDir(materiaID string) (string, error) {
	materia, err := workSegment(materiaID, "a materia")
	if err != nil {
		return "", err
	}
	return sharedRoot + "/" + fbEntregasRoot + "/" + materia, nil
}

// listarMarcasEntrega devolve as datas con marca de entrega nunha materia. Un
// cartafol que aínda non existe é "ningunha entrega".
func (a *App) listarMarcasEntrega(dir string) []string {
	items, err := a.fbList(dir)
	if err != nil {
		return []string{}
	}
	out := make([]string, 0, len(items))
	for _, it := range items {
		if it.IsDir || !strings.HasSuffix(it.Name, marcaEntregaExt) {
			continue
		}
		data := strings.TrimSuffix(it.Name, marcaEntregaExt)
		if _, err := workDate(data); err == nil {
			out = append(out, data)
		}
	}
	sort.Strings(out)
	return out
}

// ListClassDeliveryDates devolve as sesións dunha materia nas que polo menos un
// alumno entregou algo (marcas anónimas, ver arriba). Calquera conta conectada.
func (a *App) ListClassDeliveryDates(materiaID string) ([]string, error) {
	if a.profile == nil || !a.profile.Connected {
		return nil, fmt.Errorf("non hai conexión co servidor de ficheiros")
	}
	dir, err := entregasDir(materiaID)
	if err != nil {
		return nil, err
	}
	return a.listarMarcasEntrega(dir), nil
}

// MarcarEntregas deixa a marca anónima de entrega en cada unha das datas indicadas
// (sesións nas que o alumno con sesión aberta entregou), creando só as que falten.
// Devolve todas as datas con marca da materia tras marcar, para que o calendario se
// actualice sen outra petición. Só alumnado: o profesorado non entrega, e en «Acceder
// como» o frontend non a chama.
func (a *App) MarcarEntregas(materiaID string, datas []string) ([]string, error) {
	if err := a.requireStudentSession(); err != nil {
		return nil, err
	}
	if a.profile.Role != "alumno" {
		return nil, fmt.Errorf("só o alumnado marca entregas")
	}
	todas, _, err := a.crearMarcasEntrega(materiaID, datas)
	return todas, err
}

// crearMarcasEntrega crea as marcas de datas que aínda non existan na materia.
// Devolve todas as datas con marca tras crear e cantas se crearon agora.
func (a *App) crearMarcasEntrega(materiaID string, datas []string) ([]string, int, error) {
	dir, err := entregasDir(materiaID)
	if err != nil {
		return nil, 0, err
	}
	existentes := a.listarMarcasEntrega(dir)
	xa := make(map[string]bool, len(existentes))
	for _, d := range existentes {
		xa[d] = true
	}
	var novas []string
	for _, d := range datas {
		d, err := workDate(d)
		if err != nil || xa[d] {
			continue
		}
		xa[d] = true
		novas = append(novas, d)
	}
	if len(novas) == 0 {
		return existentes, 0, nil
	}
	if err := a.fbEnsureWorkDir(dir); err != nil {
		return existentes, 0, fmt.Errorf("non se puido preparar o cartafol de entregas: %w", err)
	}
	creadas := 0
	for _, d := range novas {
		if err := a.fbUpload(dir+"/"+d+marcaEntregaExt, []byte("1")); err != nil {
			log.Printf("[entregas] non se puido marcar a entrega de %s/%s: %v", materiaID, d, err)
			continue
		}
		existentes = append(existentes, d)
		creadas++
	}
	sort.Strings(existentes)
	return existentes, creadas, nil
}

// RebuildDeliveryMarks crea as marcas de entrega que falten nunha materia a partir do
// traballo xa entregado por todo o seu alumnado (práctica escrita no backup ou
// ficheiros en traballos/<materia>/<data>/). Serve para que o calendario do alumnado
// amose os puntos desde o primeiro día, sen agardar a que cada alumno entre coa versión
// nova de Tao. É idempotente (só crea as que faltan) e o frontend chámaa en segundo
// plano cando o profesorado inicia sesión. Devolve cantas marcas creou. Só o profesor
// dono da materia.
func (a *App) RebuildDeliveryMarks(materiaID string) (int, error) {
	m, err := a.requireOwnsMateria(materiaID)
	if err != nil {
		return 0, err
	}
	roster := map[string]RosterEntry{}
	if _, err := a.fbReadSharedJSON(sharedAlumnos, &roster); err != nil {
		return 0, err
	}
	var alumnos []string
	for username, e := range roster {
		for _, g := range m.Groups {
			if pertenceAGrupo(e.Group, g) {
				alumnos = append(alumnos, username)
				break
			}
		}
	}

	var mu sync.Mutex
	datas := map[string]bool{}
	enParalelo(len(alumnos), func(i int) {
		user := alumnos[i]
		if _, err := workSegment(user, "o usuario"); err != nil {
			return
		}
		atopadas := datasEntregadasBackup(a, user, m.ID)
		if fich, err := a.listWorkFileDates(user, m.ID); err == nil {
			atopadas = append(atopadas, fich...)
		}
		mu.Lock()
		for _, d := range atopadas {
			datas[d] = true
		}
		mu.Unlock()
	})

	lista := make([]string, 0, len(datas))
	for d := range datas {
		lista = append(lista, d)
	}
	sort.Strings(lista)
	_, creadas, err := a.crearMarcasEntrega(m.ID, lista)
	if creadas > 0 {
		log.Printf("[entregas] %s: creadas %d marcas de entrega a partir do traballo de %d alumnos", m.ID, creadas, len(alumnos))
	}
	return creadas, err
}

// datasEntregadasBackup devolve as datas nas que user ten a práctica escrita (contido
// non baleiro) na materia materiaID do seu backup. Un backup ausente ou ilexible non
// achega datas.
func datasEntregadasBackup(a *App, user, materiaID string) []string {
	subjects, err := a.loadStudentSubjects(user)
	if err != nil {
		return nil
	}
	var out []string
	for _, s := range subjects {
		if id, _ := s["id"].(string); id != materiaID {
			continue
		}
		logs, _ := s["logs"].(map[string]any)
		for date, v := range logs {
			entry, _ := v.(map[string]any)
			if content, _ := entry["content"].(string); strings.TrimSpace(content) != "" {
				out = append(out, date)
			}
		}
	}
	return out
}
