package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"
)

// Renovación da sesión co servidor de ficheiros.
//
// O token (JWT) que devolve o login de File Browser CADUCA: Quantum emíteo por
// defecto para 2 horas (auth.tokenExpirationHours) e o clásico tamén lle pon
// caducidade. A interface web de File Browser renóvao ela soa; Tao non o facía, así
// que pasadas esas horas a app seguía a parecer conectada, pero o servidor
// rexeitaba (401) todo o que se lle mandaba. O alumnado subía o traballo, pechaba
// sesión e ao día seguinte o traballo non estaba no servidor.
//
// Agora toda petición autenticada pasa por fbDo, que:
//   - antes de enviar, renova o token se lle queda pouco (fbTokenVixente): primeiro
//     coa ruta de renovación do propio servidor (non conta para o límite de logins
//     de Quantum, e toda a aula entra á vez = caduca á vez) e, se non vale, volvendo
//     facer login coas credenciais que xa se gardan en memoria (a.fbPassword);
//   - se aínda así chega un 401 (reloxo do equipo adiantado, servidor reiniciado con
//     outra clave), renova e repite a petición UNHA vez.
// Se as credenciais deixaron de valer (o admin cambiou o contrasinal, a conta
// borrouse ou está bloqueada) a sesión xa non se pode salvar: emítese
// "tao:sesion-caducada" e o frontend pecha a sesión cun aviso, en lugar de deixar
// ao alumno traballando nunha sesión morta.

const (
	// fbRenovarAntes: renóvase o token cando lle queda menos ca isto de vida.
	fbRenovarAntes = 20 * time.Minute
	// fbIdadeMaxToken: se o token non trae "exp" lexible, renóvase por idade.
	fbIdadeMaxToken = 45 * time.Minute
)

// errFBSesionCaducada: o servidor rexeitou a sesión e non se puido renovar.
var errFBSesionCaducada = errors.New("a sesión co servidor de ficheiros caducou; pecha a sesión e volve entrar para seguir gardando")

// fbTokenExpira le o "exp" (segundos Unix) dun JWT sen verificar a sinatura (só o
// servidor pode verificala; aquí só interesa cando deixará de aceptalo).
func fbTokenExpira(token string) (time.Time, bool) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return time.Time{}, false
	}
	payload, err := b64urlDecode(parts[1])
	if err != nil {
		return time.Time{}, false
	}
	var claims struct {
		Exp float64 `json:"exp"`
	}
	if json.Unmarshal(payload, &claims) != nil || claims.Exp <= 0 {
		return time.Time{}, false
	}
	return time.Unix(int64(claims.Exp), 0), true
}

// fbFixarToken garda un token novo da sesión actual e cando se obtivo.
func (a *App) fbFixarToken(token string) {
	a.fbToken = token
	a.fbTokenObtido = time.Now()
}

// fbSesionRenovable: hai unha sesión propia (non a de administrador que abre
// withAdminFB por un intre) e as credenciais para volver entrar.
func (a *App) fbSesionRenovable() bool {
	return a.fbAdminPass == "" && a.fbURL != "" && a.fbUser != "" && a.fbPassword != ""
}

// fbTokenPreto di se token xa caducou ou está a piques de facelo.
func (a *App) fbTokenPreto(token string) bool {
	if token == "" {
		return true
	}
	if exp, ok := fbTokenExpira(token); ok {
		return time.Until(exp) < fbRenovarAntes
	}
	return !a.fbTokenObtido.IsZero() && time.Since(a.fbTokenObtido) > fbIdadeMaxToken
}

// fbTokenVixente devolve o token co que asinar a próxima petición, renovándoo antes
// se está a piques de caducar. Se a renovación falla (servidor sen conexión)
// devólvese o que había: a petición fallará como transitoria e irá á cola.
func (a *App) fbTokenVixente() string {
	tok := a.fbToken
	if !a.fbSesionRenovable() || !a.fbTokenPreto(tok) {
		return tok
	}
	if err := a.fbRenovarSesion(""); err != nil {
		log.Printf("[sesion] non se puido renovar a sesión de %q: %v", a.fbUser, err)
	}
	return a.fbToken
}

// fbRenovarSesion obtén un token novo. rexeitado é o token que o servidor acaba de
// rexeitar cun 401 ("" se se renova só por idade): se entrementres outra goroutine
// xa o substituíu, non se fai nada. Serializado con fbSesionMu para que varias
// peticións simultáneas (cola, latexo, frontend) non disparen varios logins.
func (a *App) fbRenovarSesion(rexeitado string) error {
	a.fbSesionMu.Lock()
	defer a.fbSesionMu.Unlock()

	if !a.fbSesionRenovable() {
		return errFBSesionCaducada
	}
	actual := a.fbToken
	if rexeitado != "" && actual != rexeitado {
		return nil // xa o renovou outra petición
	}
	if rexeitado == "" && !a.fbTokenPreto(actual) {
		return nil
	}
	base, user, pass := a.fbURL, a.fbUser, a.fbPassword

	// 1) Ruta de renovación do servidor, só se o token aínda vale.
	if rexeitado == "" && actual != "" {
		if exp, ok := fbTokenExpira(actual); !ok || time.Now().Before(exp) {
			if novo, err := fbRenovarToken(base, actual); err == nil {
				a.fbFixarSeSegue(user, novo)
				log.Printf("[sesion] token renovado para %q", user)
				return nil
			}
		}
	}

	// 2) Volver entrar coas credenciais da sesión.
	novo, err := fbLogin(base, user, pass)
	if err != nil {
		if errors.Is(err, errFBBadCredentials) || errors.Is(err, errFBContaBloqueada) {
			log.Printf("[sesion] as credenciais de %q xa non valen: %v", user, err)
			emitirEvento("tao:sesion-caducada", err.Error())
			return fmt.Errorf("%w: %v", errFBSesionCaducada, err)
		}
		return err
	}
	a.fbFixarSeSegue(user, novo)
	log.Printf("[sesion] sesión de %q restablecida con novo login", user)
	return nil
}

// fbFixarSeSegue garda o token só se a sesión segue sendo a do mesmo usuario (un
// Logout ou outro login no medio da renovación non se debe pisar).
func (a *App) fbFixarSeSegue(user, token string) {
	if strings.EqualFold(a.fbUser, user) && a.fbAdminPass == "" {
		a.fbFixarToken(token)
	}
}

// fbRenovarToken pide un token novo ao servidor co actual: POST /api/auth/renew en
// Quantum, POST /api/renew no clásico. Ambos devolven o token como texto.
func fbRenovarToken(base, token string) (string, error) {
	ruta := "/api/auth/renew"
	if fbSaborDe(base) == fbClasico {
		ruta = "/api/renew"
	}
	req, err := http.NewRequest(http.MethodPost, base+ruta, nil)
	if err != nil {
		return "", err
	}
	fbAuth(req, token)
	resp, err := fbClient().Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("renovación rexeitada (%d)", resp.StatusCode)
	}
	novo := strings.TrimSpace(string(data))
	if novo == "" || strings.ContainsAny(novo, "<{ ") {
		return "", fmt.Errorf("a renovación non devolveu un token")
	}
	return novo, nil
}

// fbDo envía unha petición autenticada coa sesión actual. build constrúe a
// petición (chámase de novo se hai que repetila, así o corpo volve empezar). Un 401
// renova a sesión e repite unha vez; se non se pode renovar, devólvese a resposta
// 401 orixinal (co corpo intacto) para que o chamador informe como sempre.
func (a *App) fbDo(client *http.Client, build func() (*http.Request, error)) (*http.Response, error) {
	req, err := build()
	if err != nil {
		return nil, err
	}
	tok := a.fbTokenVixente()
	fbAuth(req, tok)
	resp, err := client.Do(req)
	if err != nil || resp.StatusCode != http.StatusUnauthorized || !a.fbSesionRenovable() {
		return resp, err
	}

	corpo, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	log.Printf("[sesion] o servidor rexeitou o token de %q (401); renovando", a.fbUser)
	if rerr := a.fbRenovarSesion(tok); rerr != nil {
		resp.Body = io.NopCloser(bytes.NewReader(corpo))
		return resp, nil
	}
	req2, err := build()
	if err != nil {
		return nil, err
	}
	fbAuth(req2, a.fbToken)
	return client.Do(req2)
}
