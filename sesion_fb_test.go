package main

import (
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// jwtCon builds an unsigned JWT-shaped token whose payload carries exp (only the
// payload is read client-side; the signature is the server's business).
func jwtCon(exp time.Time, marca string) string {
	enc := base64.RawURLEncoding.EncodeToString
	return enc([]byte(`{"alg":"HS256"}`)) + "." +
		enc([]byte(fmt.Sprintf(`{"exp":%d,"belongsTo":1,"m":%q}`, exp.Unix(), marca))) + "." + enc([]byte("sig"))
}

// The reported bug: after hours logged in, the server's token had expired, Tao kept
// using it, and every save was rejected while the UI still looked connected. Now an
// expired token (the server rejects it with 401) must be renewed transparently with
// the session's credentials and the upload must land on the server.
func TestUploadTrasCaducarOTokenVolveEntrarESobe(t *testing.T) {
	a, fake := loginAs(t, "alumno", false, nil)

	// The server "expires" the old token: from now on only the new one is accepted
	// (and a fresh login hands out the new one).
	fake.token = "tok-novo"

	if err := a.fbUpload("users/alumno/traballos/m1/2026-11-12/practica.txt", []byte("feito")); err != nil {
		t.Fatalf("fbUpload tras caducar o token: %v", err)
	}
	if got := string(fake.files["users/alumno/traballos/m1/2026-11-12/practica.txt"]); got != "feito" {
		t.Fatalf("o traballo non chegou ao servidor: %q", got)
	}
	if a.fbToken != "tok-novo" {
		t.Fatalf("a sesión debería ter o token novo, ten %q", a.fbToken)
	}
	if st := a.FBQueueStatus(); st.Pendentes != 0 {
		t.Fatalf("nada debería quedar na cola, hai %d", st.Pendentes)
	}
}

// If the credentials no longer work (the admin changed the password), the session
// cannot be saved: the write must FAIL loudly with errFBSesionCaducada, never be
// reported as saved.
func TestUploadConCredenciaisInvalidasFallaCaro(t *testing.T) {
	a, fake := loginAs(t, "alumno", false, nil)
	fake.token = "tok-novo"
	fake.password = "outro"

	err := a.fbUpload("users/alumno/x.txt", []byte("x"))
	if !errors.Is(err, errFBSesionCaducada) {
		t.Fatalf("quérese errFBSesionCaducada, veu %v", err)
	}
	if _, ok := fake.files["users/alumno/x.txt"]; ok {
		t.Fatal("non debería ter gardado nada")
	}
}

// A JWT close to its exp is renewed proactively through the server's renew route,
// before the request goes out, so the request itself is never rejected.
func TestTokenPretoDeCaducarRenovaseAntes(t *testing.T) {
	vello := jwtCon(time.Now().Add(5*time.Minute), "vello")
	novo := jwtCon(time.Now().Add(2*time.Hour), "novo")
	var renovacions, rexeitadas int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/auth/renew":
			if r.Header.Get("Authorization") != "Bearer "+vello {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			atomic.AddInt32(&renovacions, 1)
			fmt.Fprint(w, novo)
		case r.URL.Path == "/api/renew":
			w.WriteHeader(http.StatusNotFound)
		case r.URL.Path == "/api/resources":
			if r.Header.Get("Authorization") != "Bearer "+novo {
				atomic.AddInt32(&rexeitadas, 1)
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			w.WriteHeader(http.StatusOK)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()
	fbEsquecerSabor(srv.URL)

	a := &App{dataDir: t.TempDir(), fbURL: srv.URL, fbUser: "alumno", fbPassword: "segredo"}
	a.fbFixarToken(vello)
	if err := a.fbUploadDirect("users/alumno/a.txt", []byte("a")); err != nil {
		t.Fatalf("upload: %v", err)
	}
	if renovacions != 1 || rexeitadas != 0 {
		t.Fatalf("renovacións=%d rexeitadas=%d; quérese 1 e 0", renovacions, rexeitadas)
	}
	if a.fbToken != novo {
		t.Fatal("o token non se substituíu polo renovado")
	}
}

// Queued writes belong to the account that made them: on a shared classroom
// computer, the next student's session must never replay (and lose) them, nor see
// them as their own pending changes.
func TestColaNonSeReintentaCoutroUsuario(t *testing.T) {
	fake := newFakeFileBrowser("tok")
	var subidas int32
	var mu sync.Mutex // the fake's maps are read by the test while the server writes them
	ler := func(p string) string { mu.Lock(); defer mu.Unlock(); return string(fake.files[p]) }
	inner := fake.handler("bea", "segredo")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		if r.Method == http.MethodPost && r.URL.Path == "/api/resources" && r.URL.Query().Get("isDir") != "true" {
			atomic.AddInt32(&subidas, 1)
		}
		inner(w, r)
	}))
	defer srv.Close()

	a := &App{dataDir: t.TempDir(), fbURL: srv.URL, fbToken: "tok", fbUser: "bea", fbPassword: "segredo"}
	a.fbQueue = []fbOp{{ID: "1", Kind: "upload", Path: "users/ana/t.txt", Data: []byte("de ana"),
		Label: "gardar", Usuario: "ana", NextTry: time.Now()}}
	a.fbQueueInit()

	if st := a.FBQueueStatus(); st.Pendentes != 0 {
		t.Fatalf("bea non debería ver os pendentes de ana, ve %d", st.Pendentes)
	}
	time.Sleep(300 * time.Millisecond)
	if n := atomic.LoadInt32(&subidas); n != 0 {
		t.Fatalf("reintentouse a operación de ana coa sesión de bea (%d subidas)", n)
	}

	// Ana comes back to this computer: her pending write goes out.
	a.fbFixarUsuario("ana")
	a.fbQueueDespertar()
	limite := time.Now().Add(3 * time.Second)
	for time.Now().Before(limite) && ler("users/ana/t.txt") == "" {
		time.Sleep(20 * time.Millisecond)
	}
	if got := ler("users/ana/t.txt"); got != "de ana" {
		t.Fatalf("a operación de ana non se enviou cando volveu: %q", got)
	}
}
