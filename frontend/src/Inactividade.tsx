// Inactividade.tsx — peche automático da sesión cando ninguén usa Tao.
//
// Os equipos da aula son compartidos: unha sesión que queda aberta deixa a conta do
// alumno (ou do profesor) á disposición de quen se sente despois. Pasado
// INACTIVIDADE_MS sen rato, teclado nin toques, amósase un aviso cunha conta atrás
// de AVISO_MS; se ninguén responde, péchase a sesión.
//
// O tempo mídese co reloxo de parede (Date.now), non sumando intervalos: se o
// equipo se suspende, ao espertar xa se sabe que pasou o tempo e péchase decontado.
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Clock } from 'lucide-react';

export const INACTIVIDADE_MS = 30 * 60 * 1000;
export const AVISO_MS = 60 * 1000;
const COMPROBAR_MS = 1000;
const EVENTOS: (keyof WindowEventMap)[] = ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart', 'scroll'];

export function AvisoInactividade({ activo, onCaducar }: { activo: boolean; onCaducar: () => void }) {
  const { t } = useTranslation();
  const ultimaActividade = useRef(Date.now());
  const [restante, setRestante] = useState<number | null>(null); // ms ata o peche, só durante o aviso
  const onCaducarRef = useRef(onCaducar);
  onCaducarRef.current = onCaducar;

  useEffect(() => {
    if (!activo) { setRestante(null); return; }
    ultimaActividade.current = Date.now();
    const marcar = () => { ultimaActividade.current = Date.now(); };
    EVENTOS.forEach(ev => window.addEventListener(ev, marcar, { passive: true, capture: true }));
    let pechado = false;
    const id = setInterval(() => {
      const inactivo = Date.now() - ultimaActividade.current;
      if (inactivo >= INACTIVIDADE_MS) {
        if (!pechado) { pechado = true; setRestante(null); onCaducarRef.current(); }
      } else if (inactivo >= INACTIVIDADE_MS - AVISO_MS) {
        setRestante(INACTIVIDADE_MS - inactivo);
      } else {
        setRestante(null);
      }
    }, COMPROBAR_MS);
    return () => {
      clearInterval(id);
      EVENTOS.forEach(ev => window.removeEventListener(ev, marcar, { capture: true }));
    };
  }, [activo]);

  if (!activo || restante === null) return null;
  return (
    <div className="fixed inset-0 z-[100] bg-black/40 flex items-center justify-center p-4" role="alertdialog" aria-modal="true">
      <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-6 flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <Clock className="w-6 h-6 text-amber-600" />
          <h2 className="text-lg font-semibold text-stone-900">{t('sesion.inactividadeTitulo')}</h2>
        </div>
        <p className="text-sm text-stone-700">
          {t('sesion.inactividadeTexto', { min: Math.round(INACTIVIDADE_MS / 60000), seg: Math.ceil(restante / 1000) })}
        </p>
        <div className="flex justify-end gap-2">
          <button
            onClick={() => { setRestante(null); onCaducarRef.current(); }}
            className="px-4 py-2 text-sm text-stone-700 hover:bg-stone-100 rounded-lg"
          >
            {t('sesion.pecharAgora')}
          </button>
          <button
            onClick={() => { ultimaActividade.current = Date.now(); setRestante(null); }}
            className="px-4 py-2 text-sm bg-stone-900 text-white rounded-lg hover:bg-stone-800"
            autoFocus
          >
            {t('sesion.seguir')}
          </button>
        </div>
      </div>
    </div>
  );
}
