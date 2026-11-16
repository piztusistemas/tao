package main

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// Rexistro de conexións do alumnado (informe de seguimento).
//
// Ata agora Tao só sabía QUEN está conectado AGORA (dixitalizacion/sesions/<equipo>.json,
// para o mapa de Piztu), non que días se conectou cada alumno. Para que o profesorado
// poida pedir un informe de seguimento (días con conexión e días con entrega, por UD —
// ver SeguimentoAlumno.tsx), cada alumno deixa no seu propio cartafol un rexistro
// diario:
//
//	users/<login>/conexions.json -> {"dias": {"2026-11-16": {"primeira": "09:02", "equipos": ["aula1-03"]}}}
//
// Escríbese ao iniciar sesión e, se a app segue aberta, cando cambia o día (latexo de
// app.go). Só se apunta UNHA vez por día e equipo, así que o custo é unha lectura e unha
// escritura por alumno e día. Só o alumnado deixa rexistro: o profesorado non é obxecto
// do informe. Os días anteriores a esta versión de Tao non teñen rexistro.

// fbConexionsFile é o nome do rexistro de conexións dentro de users/<login>/.
const fbConexionsFile = "conexions.json"

// ConexionDia é o que se garda de cada día con conexión.
type ConexionDia struct {
	Primeira string   `json:"primeira"`          // hora (HH:MM) da primeira conexión do día
	Equipos  []string `json:"equipos,omitempty"` // equipos (hostname) desde os que entrou ese día
}

// rexistroConexions é o contido de conexions.json.
type rexistroConexions struct {
	Dias map[string]ConexionDia `json:"dias"`
}

// ConexionRexistro é un día con conexión, aplanado para o frontend (Wails non xera tipo
// para os valores dun mapa).
type ConexionRexistro struct {
	Data     string   `json:"data"` // YYYY-MM-DD
	Primeira string   `json:"primeira"`
	Equipos  []string `json:"equipos"`
}

// rexistrarConexion apunta o día de hoxe no rexistro de conexións do alumno con sesión
// aberta. É a mellor posible: un fallo só se rexistra no log e nunca impide entrar.
func (a *App) rexistrarConexion() {
	a.rexistrarConexionEn(time.Now())
}

func (a *App) rexistrarConexionEn(agora time.Time) {
	a.apiEstadoMu.RLock()
	p := a.profile
	a.apiEstadoMu.RUnlock()
	if p == nil || !p.Connected || p.Role != "alumno" || a.fbToken == "" {
		return
	}
	user, err := workSegment(p.Username, "o usuario")
	if err != nil {
		return
	}
	equipo, _ := os.Hostname()
	data := agora.Format("2006-01-02")
	clave := strings.ToLower(user) + "|" + data + "|" + equipo

	a.conexionsMu.Lock()
	defer a.conexionsMu.Unlock()
	if a.conexionsClave == clave {
		return // xa apuntado hoxe desde este equipo
	}

	ruta := fbUsersRoot + "/" + user + "/" + fbConexionsFile
	rex, err := a.lerConexions(user)
	if err != nil {
		// Un ficheiro corrupto non se sobrescribe a cegas: perderíase o histórico.
		log.Printf("[conexions] non se puido ler o rexistro de %q: %v", user, err)
		return
	}
	dia, xa := rex.Dias[data]
	if !xa {
		dia.Primeira = agora.Format("15:04")
	}
	if equipo != "" && !contenIgnorandoMaiusculas(dia.Equipos, equipo) {
		dia.Equipos = append(dia.Equipos, equipo)
	} else if xa {
		a.conexionsClave = clave
		return // nada novo que gardar
	}
	rex.Dias[data] = dia

	raw, err := json.MarshalIndent(rex, "", "  ")
	if err != nil {
		return
	}
	if err := a.fbUpload(ruta, raw); err != nil {
		log.Printf("[conexions] non se puido gardar o rexistro de %q: %v", user, err)
		return
	}
	a.conexionsClave = clave
}

// lerConexions descarga o rexistro de conexións de user. Un ficheiro que aínda non
// existe é un rexistro baleiro; un ficheiro ilexible é un erro.
func (a *App) lerConexions(user string) (rexistroConexions, error) {
	rex := rexistroConexions{Dias: map[string]ConexionDia{}}
	content, err := a.fbRawGet(fbUsersRoot + "/" + user + "/" + fbConexionsFile)
	if err != nil || len(strings.TrimSpace(string(content))) == 0 {
		return rex, nil // aínda sen rexistro
	}
	if err := json.Unmarshal(content, &rex); err != nil {
		return rex, fmt.Errorf("%s non válido: %w", fbConexionsFile, err)
	}
	if rex.Dias == nil {
		rex.Dias = map[string]ConexionDia{}
	}
	return rex, nil
}

func contenIgnorandoMaiusculas(lista []string, s string) bool {
	for _, x := range lista {
		if strings.EqualFold(x, s) {
			return true
		}
	}
	return false
}

// GetStudentConnections devolve, ordenados por data, os días en que un alumno se
// conectou a Tao (ver rexistrarConexion). Só profesorado.
func (a *App) GetStudentConnections(username string) ([]ConexionRexistro, error) {
	if err := a.requireProfessor(); err != nil {
		return nil, err
	}
	user, err := workSegment(username, "o usuario")
	if err != nil {
		return nil, err
	}
	rex, err := a.lerConexions(user)
	if err != nil {
		return nil, err
	}
	out := make([]ConexionRexistro, 0, len(rex.Dias))
	for data, d := range rex.Dias {
		equipos := d.Equipos
		if equipos == nil {
			equipos = []string{}
		}
		out = append(out, ConexionRexistro{Data: data, Primeira: d.Primeira, Equipos: equipos})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Data < out[j].Data })
	return out, nil
}

// ExportTrackingReportPDF converte en PDF o informe de seguimento dun alumno (HTML
// xerado por SeguimentoAlumno.tsx) e pregunta onde gardalo. Devolve a ruta gardada, ou
// "" se se cancela. Non se asina: é un documento de traballo do profesorado. Só
// profesorado.
func (a *App) ExportTrackingReportPDF(html, suggestedName string) (string, error) {
	if err := a.requireProfessor(); err != nil {
		return "", err
	}
	if strings.TrimSpace(html) == "" {
		return "", fmt.Errorf("o informe está baleiro")
	}
	if suggestedName == "" {
		suggestedName = "seguimento.pdf"
	}
	if !strings.HasSuffix(strings.ToLower(suggestedName), ".pdf") {
		suggestedName += ".pdf"
	}
	pdf, err := renderizarPDF(html)
	if err != nil {
		return "", err
	}
	dest, err := gardarFicheiro("Gardar o informe de seguimento", suggestedName,
		application.FileFilter{DisplayName: "PDF (*.pdf)", Pattern: "*.pdf"})
	if err != nil || dest == "" {
		return "", err
	}
	if err := os.WriteFile(dest, pdf, 0o644); err != nil {
		return "", fmt.Errorf("non se puido gardar o PDF: %w", err)
	}
	return dest, nil
}
