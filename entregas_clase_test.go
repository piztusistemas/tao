package main

import (
	"reflect"
	"testing"
)

func TestMateriaEntregaBloqueada(t *testing.T) {
	raw := []byte(`{"id":"m1","logs":{"2026-11-17":{"date":"2026-11-17","status":"lectivo","locked":true},"2026-11-18":{"unlocked":true}}}`)
	if !materiaEntregaBloqueada(raw, "2026-11-17") {
		t.Error("a sesión bloqueada debería constar como bloqueada")
	}
	if materiaEntregaBloqueada(raw, "2026-11-18") {
		t.Error("unha sesión sen locked non está bloqueada")
	}
	if materiaEntregaBloqueada(raw, "2026-11-19") {
		t.Error("unha sesión sen log non está bloqueada")
	}
	if materiaEntregaBloqueada([]byte(`non é json`), "2026-11-17") {
		t.Error("un JSON ilexible non bloquea")
	}
	if materiaEntregaBloqueada([]byte(`{"id":"m1"}`), "2026-11-17") {
		t.Error("unha materia sen logs non bloquea")
	}
}

func TestDatasValidasOrdenadas(t *testing.T) {
	got := datasValidasOrdenadas([]string{"2026-11-17", "lixo", "2026-10-01", "2026-11-17", "2026-13-40"})
	want := []string{"2026-10-01", "2026-11-17"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("datasValidasOrdenadas = %v, queríase %v", got, want)
	}
	if got := datasValidasOrdenadas(nil); got == nil || len(got) != 0 {
		t.Errorf("sen datas debería devolver unha lista baleira, non %v", got)
	}
}
