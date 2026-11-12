package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestExternosTao(t *testing.T) {
	dir := t.TempDir()

	// Módulo válido.
	valido := filepath.Join(dir, "proba")
	if err := os.MkdirAll(valido, 0o755); err != nil {
		t.Fatal(err)
	}
	manifest := `{"id":"proba","nome":"Proba","icona":"🧩","executable":"proba","version":"1.0","permisos":["materias.ler"]}`
	if err := os.WriteFile(filepath.Join(valido, "modulo.json"), []byte(manifest), 0o644); err != nil {
		t.Fatal(err)
	}

	// Cartafol sen modulo.json — debe ignorarse en silencio.
	if err := os.MkdirAll(filepath.Join(dir, "lixo"), 0o755); err != nil {
		t.Fatal(err)
	}

	// modulo.json incompleto (sen executable) — debe ignorarse.
	incompleto := filepath.Join(dir, "incompleto")
	if err := os.MkdirAll(incompleto, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(incompleto, "modulo.json"), []byte(`{"id":"incompleto"}`), 0o644); err != nil {
		t.Fatal(err)
	}

	modulos := ExternosTao(dir)
	if len(modulos) != 1 {
		t.Fatalf("esperaba 1 módulo válido, atopei %d: %+v", len(modulos), modulos)
	}
	m := modulos[0]
	if m.ID != "proba" || m.Nome != "Proba" || m.Executable != "proba" || m.Version != "1.0" {
		t.Fatalf("módulo inesperado: %+v", m)
	}
	if len(m.Permisos) != 1 || m.Permisos[0] != "materias.ler" {
		t.Fatalf("permisos inesperados: %+v", m.Permisos)
	}

	if _, ok := BuscarModuloTao(dir, "non-existe"); ok {
		t.Fatal("BuscarModuloTao debería devolver ok=false para un id descoñecido")
	}
	if got, ok := BuscarModuloTao(dir, "proba"); !ok || got.ID != "proba" {
		t.Fatalf("BuscarModuloTao(proba) = %+v, %v", got, ok)
	}
}

func TestExternosTaoDirInexistente(t *testing.T) {
	if modulos := ExternosTao(filepath.Join(t.TempDir(), "non-existe")); modulos != nil {
		t.Fatalf("esperaba nil para un cartafol inexistente, atopei %+v", modulos)
	}
}

// Malta conta coma activo en canto está instalado, sen pasar por ⚙ → Módulos,
// pero unha desactivación explícita do profesorado respéctase.
func TestMaltaActivoPorDefectoSeEstaInstalado(t *testing.T) {
	a := &App{dataDir: t.TempDir(), taoModulosDir: t.TempDir()}
	if a.moduloTaoActivo("malta") {
		t.Fatal("sen Malta instalado non pode contar coma activo")
	}

	dir := filepath.Join(a.taoModulosDir, "malta")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	manifest := `{"id":"malta","nome":"Malta","executable":"malta","version":"1.0","permisos":["materias.ler"]}`
	if err := os.WriteFile(filepath.Join(dir, "modulo.json"), []byte(manifest), 0o644); err != nil {
		t.Fatal(err)
	}
	if !a.moduloTaoActivo("malta") {
		t.Fatal("Malta instalado debería estar activo por defecto")
	}
	if p := a.estadoModuloTaoEfectivo("malta").Permisos; len(p) != 1 || p[0] != "materias.ler" {
		t.Fatalf("por defecto debería ter os permisos do seu modulo.json, ten %v", p)
	}
	if a.moduloTaoActivo("proba") {
		t.Fatal("outros módulos seguen inactivos por defecto")
	}

	if err := a.setModuloTaoActivo("malta", false, nil); err != nil {
		t.Fatal(err)
	}
	if a.moduloTaoActivo("malta") {
		t.Fatal("unha desactivación explícita ten que respectarse")
	}
}
