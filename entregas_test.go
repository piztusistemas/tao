package main

import (
	"reflect"
	"strings"
	"testing"
)

func TestMarcarEntregasAnonimasECompartidas(t *testing.T) {
	fake := newFakeFileBrowser("tok")
	seedShared(fake)
	fake.files["dixitalizacion/profesores.json"] = mustJSON(t, []string{"prof"})

	ana := loginStudent(t, fake, "ana")
	got, err := ana.MarcarEntregas("m1", []string{"2026-11-03", "2026-11-05", "non-é-data", "2026-11-03"})
	if err != nil {
		t.Fatalf("MarcarEntregas: %v", err)
	}
	if want := []string{"2026-11-03", "2026-11-05"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("marcas = %v, quere %v", got, want)
	}
	// A marca é anónima: nin o nome do ficheiro nin o contido levan o usuario.
	for path, content := range fake.files {
		if strings.HasPrefix(path, "dixitalizacion/entregas/") && (strings.Contains(path, "ana") || strings.Contains(string(content), "ana")) {
			t.Fatalf("a marca identifica ao alumno: %s = %q", path, content)
		}
	}

	bea := loginStudent(t, fake, "bea")
	got, err = bea.MarcarEntregas("m1", []string{"2026-11-05", "2026-11-10"})
	if err != nil {
		t.Fatalf("MarcarEntregas bea: %v", err)
	}
	if want := []string{"2026-11-03", "2026-11-05", "2026-11-10"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("marcas tras bea = %v, quere %v", got, want)
	}
	lidas, err := ana.ListClassDeliveryDates("m1")
	if err != nil || len(lidas) != 3 {
		t.Fatalf("ListClassDeliveryDates = %v, %v", lidas, err)
	}
	if outra, _ := ana.ListClassDeliveryDates("m2"); len(outra) != 0 {
		t.Fatalf("outra materia non debería ter marcas: %v", outra)
	}

	prof := loginStudent(t, fake, "prof")
	if _, err := prof.MarcarEntregas("m1", []string{"2026-11-11"}); err == nil {
		t.Fatal("o profesorado non debería marcar entregas")
	}
	if _, err := ana.MarcarEntregas("../x", []string{"2026-11-11"}); err == nil {
		t.Fatal("materia con traversal aceptada")
	}
}

func TestRebuildDeliveryMarksDesdeOTraballoExistente(t *testing.T) {
	fake := newFakeFileBrowser("tok")
	seedShared(fake)
	fake.files["dixitalizacion/profesores.json"] = mustJSON(t, []string{"prof"})
	fake.files["dixitalizacion/alumnos.json"] = mustJSON(t, map[string]RosterEntry{
		"ana":   {Name: "Ana", Group: "eso1a"},
		"bea":   {Name: "Bea", Group: "eso1a"},
		"carla": {Name: "Carla", Group: "eso2b"}, // non cursa m1
	})
	fake.files["dixitalizacion/materias/m1.json"] = mustJSON(t, MateriaDef{ID: "m1", Owner: "prof", Groups: []string{"eso1a"}})
	fake.files["users/ana/"+fbBackupName] = mustJSON(t, []map[string]any{{
		"id": "m1",
		"logs": map[string]any{
			"2026-11-03": map[string]any{"date": "2026-11-03", "content": "Fixen a práctica", "status": "lectivo"},
			"2026-11-04": map[string]any{"date": "2026-11-04", "content": "   ", "status": "lectivo"}, // baleira
		},
	}})
	fake.dirs["users/bea/traballos/m1"] = true
	fake.dirs["users/bea/traballos/m1/2026-11-05"] = true
	fake.files["users/bea/traballos/m1/2026-11-05/circuito.fzz"] = []byte("x")
	fake.files["users/carla/"+fbBackupName] = mustJSON(t, []map[string]any{{
		"id":   "m1",
		"logs": map[string]any{"2026-11-07": map[string]any{"content": "non conta"}},
	}})

	prof := loginStudent(t, fake, "prof")
	creadas, err := prof.RebuildDeliveryMarks("m1")
	if err != nil {
		t.Fatalf("RebuildDeliveryMarks: %v", err)
	}
	if creadas != 2 {
		t.Fatalf("creadas = %d, quere 2", creadas)
	}
	got, _ := prof.ListClassDeliveryDates("m1")
	if want := []string{"2026-11-03", "2026-11-05"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("marcas = %v, quere %v", got, want)
	}
	// Idempotente: unha segunda pasada non crea nada.
	if n, err := prof.RebuildDeliveryMarks("m1"); err != nil || n != 0 {
		t.Fatalf("segunda pasada = %d, %v; quere 0", n, err)
	}
	// Un alumno non pode reconstruír.
	ana := loginStudent(t, fake, "ana")
	if _, err := ana.RebuildDeliveryMarks("m1"); err == nil {
		t.Fatal("un alumno non debería poder reconstruír as marcas")
	}
}
