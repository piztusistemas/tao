package main

import (
	"encoding/json"
	"os"
	"testing"
	"time"
)

func TestRexistrarConexionApuntaUnhaVezPorDia(t *testing.T) {
	fake := newFakeFileBrowser("tok")
	seedShared(fake)
	fake.dirs["users"] = true
	fake.dirs["users/alumno"] = true
	a := loginStudent(t, fake, "alumno")

	dia := time.Date(2026, 11, 3, 9, 5, 0, 0, time.Local)
	a.rexistrarConexionEn(dia)
	a.rexistrarConexionEn(dia.Add(2 * time.Hour)) // mesmo día: non cambia a primeira hora
	a.rexistrarConexionEn(dia.AddDate(0, 0, 1))

	var rex rexistroConexions
	if err := json.Unmarshal(fake.files["users/alumno/"+fbConexionsFile], &rex); err != nil {
		t.Fatalf("conexions.json non válido: %v", err)
	}
	d, ok := rex.Dias["2026-11-03"]
	if !ok || d.Primeira != "09:05" {
		t.Fatalf("día 3 = %+v (ok=%v), quere primeira 09:05", d, ok)
	}
	if host, _ := os.Hostname(); host != "" && (len(d.Equipos) != 1 || d.Equipos[0] != host) {
		t.Fatalf("equipos = %v, quere [%s]", d.Equipos, host)
	}
	if _, ok := rex.Dias["2026-11-04"]; !ok {
		t.Fatalf("falta o día 4: %+v", rex.Dias)
	}
	// O login tamén apuntou hoxe.
	if _, ok := rex.Dias[time.Now().Format("2006-01-02")]; !ok {
		t.Fatalf("o login non apuntou o día de hoxe: %+v", rex.Dias)
	}
}

func TestGetStudentConnectionsSoProfesorado(t *testing.T) {
	fake := newFakeFileBrowser("tok")
	seedShared(fake)
	fake.files["dixitalizacion/profesores.json"] = mustJSON(t, []string{"prof"})
	fake.files["users/alumno/"+fbConexionsFile] = mustJSON(t, rexistroConexions{Dias: map[string]ConexionDia{
		"2026-11-05": {Primeira: "10:00", Equipos: []string{"pc2"}},
		"2026-11-02": {Primeira: "08:30"},
	}})

	alumno := loginStudent(t, fake, "alumno")
	if _, err := alumno.GetStudentConnections("alumno"); err == nil {
		t.Fatal("un alumno non debería poder ler o rexistro de conexións")
	}

	prof := loginStudent(t, fake, "prof")
	got, err := prof.GetStudentConnections("alumno")
	if err != nil {
		t.Fatalf("GetStudentConnections: %v", err)
	}
	// O propio login do alumno apuntou tamén o día de hoxe, ao final.
	if len(got) != 3 || got[0].Data != "2026-11-02" || got[1].Data != "2026-11-05" || got[1].Primeira != "10:00" {
		t.Fatalf("resultado inesperado: %+v", got)
	}
	if got[0].Equipos == nil {
		t.Fatal("equipos debería ser unha lista baleira, non nil")
	}
	if _, err := prof.GetStudentConnections("../outro"); err == nil {
		t.Fatal("usuario con traversal aceptado")
	}
}
