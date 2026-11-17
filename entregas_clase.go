package main

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"
	"sync"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// Informe do grao de entrega de toda a clase e bloqueo da entrega dunha sesión.
//
// O informe (InformeEntregas.tsx) cruza a programación da materia (calendario + UD) coas
// entregas de cada alumno matriculado nela: mesmo criterio que o informe de seguimento
// individual (SeguimentoAlumno.tsx) — entregar unha sesión é ter a práctica escrita ou
// ficheiros de traballo subidos a ela. O cálculo por UD/avaliación faise no frontend, que
// xa ten a programación; aquí só se recollen, en paralelo, as datas entregadas de cada
// alumno.
//
// O bloqueo da entrega vive no log-modelo do profesor (MateriaDef.Logs[data].locked),
// igual có desbloqueo dun día pasado (unlocked): o alumnado recíbeo co resto da materia
// (GetMyMaterias, sondaxe cada poucos segundos) e o frontend deixa a resposta en só
// lectura. Os ficheiros de traballo compróbanse tamén aquí (UploadWorkFiles/
// DeleteWorkFile), para que un frontend vello ou unha materia sen refrescar non poidan
// saltalo.

// EntregasAlumno son as sesións entregadas dun alumno nunha materia.
type EntregasAlumno struct {
	Username  string   `json:"username"`
	Name      string   `json:"name"`
	Surname   string   `json:"surname"`
	Group     string   `json:"group"`
	Practicas []string `json:"practicas"` // datas coa práctica escrita no backup
	Ficheiros []string `json:"ficheiros"` // datas con ficheiros en traballos/<materia>/<data>/
}

// GetClassDeliveries devolve, para cada alumno dos grupos da materia, as datas nas que
// entregou algo. Só o profesor dono da materia.
func (a *App) GetClassDeliveries(materiaID string) ([]EntregasAlumno, error) {
	m, err := a.requireOwnsMateria(materiaID)
	if err != nil {
		return nil, err
	}
	roster := map[string]RosterEntry{}
	if _, err := a.fbReadSharedJSON(sharedAlumnos, &roster); err != nil {
		return nil, err
	}
	var alumnos []EntregasAlumno
	for username, e := range roster {
		if _, err := workSegment(username, "o usuario"); err != nil {
			continue
		}
		for _, g := range m.Groups {
			if pertenceAGrupo(e.Group, g) {
				alumnos = append(alumnos, EntregasAlumno{Username: username, Name: e.Name, Surname: e.Surname, Group: e.Group})
				break
			}
		}
	}
	// O mesmo filtro defensivo que ListRoster: un profesor dado de alta tamén como
	// alumno por erro non entra no informe.
	profs := map[string]bool{}
	var lista []string
	if _, err := a.fbReadSharedJSON(sharedProfesores, &lista); err == nil {
		for _, p := range lista {
			profs[strings.ToLower(strings.TrimSpace(p))] = true
		}
	}
	filtrados := alumnos[:0]
	for _, al := range alumnos {
		if !profs[strings.ToLower(al.Username)] {
			filtrados = append(filtrados, al)
		}
	}
	alumnos = filtrados

	var mu sync.Mutex
	enParalelo(len(alumnos), func(i int) {
		al := &alumnos[i]
		practicas := datasEntregadasBackup(a, al.Username, m.ID)
		ficheiros, _ := a.listWorkFileDates(al.Username, m.ID)
		mu.Lock()
		defer mu.Unlock()
		al.Practicas = datasValidasOrdenadas(practicas)
		al.Ficheiros = datasValidasOrdenadas(ficheiros)
	})
	sort.Slice(alumnos, func(i, j int) bool {
		ki := strings.ToLower(alumnos[i].Surname + " " + alumnos[i].Name + " " + alumnos[i].Username)
		kj := strings.ToLower(alumnos[j].Surname + " " + alumnos[j].Name + " " + alumnos[j].Username)
		return ki < kj
	})
	return alumnos, nil
}

// datasValidasOrdenadas descarta o que non sexa unha data YYYY-MM-DD, quita duplicados
// e ordena. Nunca devolve nil (Wails serializaríao como null).
func datasValidasOrdenadas(datas []string) []string {
	vistas := map[string]bool{}
	out := []string{}
	for _, d := range datas {
		d, err := workDate(d)
		if err != nil || vistas[d] {
			continue
		}
		vistas[d] = true
		out = append(out, d)
	}
	sort.Strings(out)
	return out
}

// ExportDeliveryReportPDF converte en PDF o informe de entregas da clase (HTML xerado
// por InformeEntregas.tsx) e pregunta onde gardalo. Devolve a ruta gardada, ou "" se se
// cancela. Só profesorado.
func (a *App) ExportDeliveryReportPDF(html, suggestedName string) (string, error) {
	if err := a.requireProfessor(); err != nil {
		return "", err
	}
	return exportarInformePDF(html, suggestedName, "entregas.pdf", "Gardar o informe de entregas")
}

// exportarInformePDF renderiza html a PDF e gárdao onde escolla a persoa.
func exportarInformePDF(html, suggestedName, porDefecto, titulo string) (string, error) {
	if strings.TrimSpace(html) == "" {
		return "", fmt.Errorf("o informe está baleiro")
	}
	if suggestedName == "" {
		suggestedName = porDefecto
	}
	if !strings.HasSuffix(strings.ToLower(suggestedName), ".pdf") {
		suggestedName += ".pdf"
	}
	pdf, err := renderizarPDF(html)
	if err != nil {
		return "", err
	}
	dest, err := gardarFicheiro(titulo, suggestedName,
		application.FileFilter{DisplayName: "PDF (*.pdf)", Pattern: "*.pdf"})
	if err != nil || dest == "" {
		return "", err
	}
	if err := os.WriteFile(dest, pdf, 0o644); err != nil {
		return "", fmt.Errorf("non se puido gardar o PDF: %w", err)
	}
	return dest, nil
}

// entregaBloqueada di se o profesor bloqueou a entrega da sesión date da materia
// (Logs[date].locked no seu log-modelo). Ante calquera erro lendo a materia devolve
// false: o bloqueo é unha restrición opcional e non debe impedir traballar se o
// servidor responde mal.
func (a *App) entregaBloqueada(materiaID, date string) bool {
	id, err := workSegment(materiaID, "a materia")
	if err != nil {
		return false
	}
	raw, err := a.fbRawGet(sharedRoot + "/" + sharedMateriasDir + "/" + id + ".json")
	if err != nil || len(raw) == 0 {
		return false
	}
	return materiaEntregaBloqueada(raw, date)
}

// materiaEntregaBloqueada le Logs[date].locked dunha definición de materia en JSON.
func materiaEntregaBloqueada(raw []byte, date string) bool {
	var m struct {
		Logs map[string]struct {
			Locked bool `json:"locked"`
		} `json:"logs"`
	}
	if err := json.Unmarshal(raw, &m); err != nil {
		return false
	}
	return m.Logs[date].Locked
}

// requireEntregaAberta impide ao alumnado subir ou borrar ficheiros de traballo nunha
// sesión coa entrega bloqueada. O profesorado nunca está suxeito ao bloqueo.
func (a *App) requireEntregaAberta(materiaID, date string) error {
	if a.profile == nil || a.profile.Role != "alumno" {
		return nil
	}
	if a.entregaBloqueada(materiaID, date) {
		return fmt.Errorf("o profesorado bloqueou a entrega desta sesión")
	}
	return nil
}
