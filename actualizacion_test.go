package main

import "testing"

func TestEstadoDesdeReleaseTao(t *testing.T) {
	release := releaseGitHubTao{
		TagName: "v26.11.4",
		Body:    "Novidades",
		Assets: []ficheiroGitHubTao{
			{Name: "outro.zip", DownloadURL: "https://x/outro.zip"},
			{Name: "tao_26.11.4.zip.sha256", DownloadURL: "https://x/tao_26.11.4.zip.sha256"},
			{Name: "tao_26.11.4.zip", DownloadURL: "https://x/tao_26.11.4.zip"},
		},
	}
	e := estadoDesdeReleaseTao(EstadoActualizacionTao{VersionLocal: "26.11.3"}, release)
	if !e.Disponible || e.VersionRemota != "26.11.4" || e.URLDescarga != "https://x/tao_26.11.4.zip" ||
		e.URLChecksum != "https://x/tao_26.11.4.zip.sha256" || e.Notas != "Novidades" {
		t.Fatalf("estado inesperado: %+v", e)
	}
	if e := estadoDesdeReleaseTao(EstadoActualizacionTao{VersionLocal: "26.11.4"}, release); e.Disponible {
		t.Fatalf("a mesma versión non debe ofrecerse como actualización: %+v", e)
	}
	// Tag sen número de versión: úsase o nome do .zip.
	release.TagName = "ultima"
	if e := estadoDesdeReleaseTao(EstadoActualizacionTao{VersionLocal: "26.11.3"}, release); e.VersionRemota != "26.11.4" {
		t.Fatalf("esperaba a versión do nome do zip: %+v", e)
	}
	// Release sen o .zip do módulo: non hai actualización.
	if e := estadoDesdeReleaseTao(EstadoActualizacionTao{VersionLocal: "1"}, releaseGitHubTao{TagName: "v99"}); e.Disponible {
		t.Fatalf("sen zip non debe haber actualización: %+v", e)
	}
}

func TestComprobarActualizacionTaoRedeReal(t *testing.T) {
	if testing.Short() {
		t.Skip("precisa rede")
	}
	e := comprobarActualizacionTaoRede()
	t.Logf("remota=%q zip=%q sha=%q disponible=%v", e.VersionRemota, e.URLDescarga, e.URLChecksum, e.Disponible)
}
