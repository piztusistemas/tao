// InformeEntregas.tsx — informe do grao de entrega de tarefas de toda a clase.
//
// Para a avaliación escollida (meses que define o profesorado, gardados en
// config.evaluations da materia), cruza as sesións de clase xa impartidas da
// programación (calendario + UD, coas reprogramacións do log-modelo do profesor) coas
// entregas de cada alumno matriculado (GetClassDeliveries, tao/entregas_clase.go). O
// criterio de entrega é o mesmo do informe de seguimento individual
// (SeguimentoAlumno.tsx): práctica escrita ou ficheiros de traballo subidos á sesión; as
// sesións de exame non contan.
//
// Resultado: porcentaxe de entrega de cada alumno por UD e unha porcentaxe global sobre
// as UD que escolla o profesor (sesións entregadas / sesións avaliables de todas elas, é
// dicir, cada UD pesa segundo as súas sesións), exportable a PDF.
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Loader2, Download, Users, Plus, Trash2, Pencil, Save } from 'lucide-react';
import { Subject, Evaluation, DailyLog } from './types';
import { generateMonthlySchedule } from './data';
import { GetClassDeliveries, ExportDeliveryReportPDF, OpenFile } from '../bindings/tao/app';
import { EntregasAlumno } from '../bindings/tao/models';
import { esc, fmtShort } from './reportHtml';

type T = (key: string, opts?: Record<string, any>) => string;

const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : 0);

function isoHoxe(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ---- Meses e avaliacións -----------------------------------------------------------

// mesesCurso devolve os meses (YYYY-MM) que abrangue o curso, en orde.
export function mesesCurso(start: string, end: string): string[] {
  if (!start || !end || start > end) return [];
  const out: string[] = [];
  let y = Number(start.slice(0, 4)), m = Number(start.slice(5, 7));
  const fin = end.slice(0, 7);
  for (let i = 0; i < 36; i++) {
    const k = `${y}-${String(m).padStart(2, '0')}`;
    out.push(k);
    if (k >= fin) break;
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out;
}

const ultimoDia = (mes: string) => {
  const y = Number(mes.slice(0, 4)), m = Number(mes.slice(5, 7));
  return `${mes}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;
};

// avaliacionDesdeMeses converte un rango de meses en datas, recortado ao curso.
export function avaliacionDesdeMeses(name: string, desde: string, ata: string, cursoIni: string, cursoFin: string): Evaluation {
  const ini = `${desde}-01`;
  const fin = ultimoDia(ata);
  return {
    name,
    startDate: cursoIni && ini < cursoIni ? cursoIni : ini,
    endDate: cursoFin && fin > cursoFin ? cursoFin : fin,
  };
}

// avaliacionsSuxeridas propón tres avaliacións por meses para o curso: ata decembro,
// xaneiro–marzo e abril ata o final (ou o curso en tres partes se non encaixa).
export function avaliacionsSuxeridas(t: T, cursoIni: string, cursoFin: string): Evaluation[] {
  const meses = mesesCurso(cursoIni, cursoFin);
  if (meses.length === 0) return [];
  const y = Number(cursoIni.slice(0, 4));
  const dec = `${y}-12`, mar = `${y + 1}-03`;
  let cortes: [string, string][];
  if (meses.includes(dec) && meses.includes(mar) && meses[meses.length - 1] > mar) {
    cortes = [[meses[0], dec], [`${y + 1}-01`, mar], [`${y + 1}-04`, meses[meses.length - 1]]];
  } else {
    const n = meses.length, a = Math.ceil(n / 3), b = Math.ceil((2 * n) / 3);
    cortes = [[meses[0], meses[a - 1]], [meses[Math.min(a, n - 1)], meses[b - 1]], [meses[Math.min(b, n - 1)], meses[n - 1]]];
    cortes = cortes.filter(([d, h]) => d <= h);
  }
  return cortes.map(([d, h], i) => avaliacionDesdeMeses(t('informeEntregas.avaliacionN', { n: i + 1 }), d, h, cursoIni, cursoFin));
}

// avaliacionsVixentes: as avaliacións gardadas se caen dentro do curso; se non (p.ex. as
// de exemplo dun curso pasado, que veñen en defaultConfig), as suxeridas.
function avaliacionsVixentes(t: T, subject: Subject): { evals: Evaluation[]; suxeridas: boolean } {
  const { startDate, endDate } = subject.config;
  const gardadas = (subject.config.evaluations || []).filter(e => e && e.startDate && e.endDate);
  const valen = gardadas.length > 0 && gardadas.every(e => e.endDate >= startDate && e.startDate <= endDate);
  if (valen) return { evals: gardadas, suxeridas: false };
  return { evals: avaliacionsSuxeridas(t, startDate, endDate), suxeridas: true };
}

// ---- Cálculo -----------------------------------------------------------------------

export interface SesionClase { date: string; unitId: number; exame: boolean }

// sesionsImpartidas: sesións de clase da programación entre from e ata (incluídas).
export function sesionsImpartidas(subject: Subject, logs: Record<string, DailyLog>, from: string, ata: string): SesionClase[] {
  const { months } = generateMonthlySchedule(subject.config, subject.units, logs || {});
  const out: SesionClase[] = [];
  for (const m of months) {
    for (const d of m.days) {
      if (!d.unit || d.dateString < from || d.dateString > ata) continue;
      out.push({ date: d.dateString, unitId: d.unit.id, exame: logs?.[d.dateString]?.status === 'exame' });
    }
  }
  return out;
}

export interface CeldaUD { avaliables: number; entregadas: number }
export interface FilaAlumno {
  alumno: EntregasAlumno;
  porUD: Map<number, CeldaUD>;
  global: CeldaUD;
}

export function calcularEntregasClase(sesions: SesionClase[], alumnos: EntregasAlumno[], udsGlobal: Set<number>): FilaAlumno[] {
  return alumnos.map(al => {
    const entregou = new Set([...(al.practicas || []), ...(al.ficheiros || [])]);
    const porUD = new Map<number, CeldaUD>();
    const global = { avaliables: 0, entregadas: 0 };
    for (const s of sesions) {
      if (s.exame) continue;
      const c = porUD.get(s.unitId) || { avaliables: 0, entregadas: 0 };
      c.avaliables++;
      const ok = entregou.has(s.date);
      if (ok) c.entregadas++;
      porUD.set(s.unitId, c);
      if (udsGlobal.has(s.unitId)) {
        global.avaliables++;
        if (ok) global.entregadas++;
      }
    }
    return { alumno: al, porUD, global };
  });
}

const nomeAlumno = (a: EntregasAlumno) => [a.surname, a.name].filter(Boolean).join(', ') || a.username;

const sumaCeldas = (celdas: (CeldaUD | undefined)[]): CeldaUD =>
  celdas.reduce<CeldaUD>((acc, c) => ({ avaliables: acc.avaliables + (c?.avaliables || 0), entregadas: acc.entregadas + (c?.entregadas || 0) }), { avaliables: 0, entregadas: 0 });

const nivel = (c: CeldaUD) => {
  if (c.avaliables === 0) return '';
  const p = pct(c.entregadas, c.avaliables);
  return p >= 75 ? 'ok' : p >= 50 ? 'medio' : 'ko';
};

// ---- PDF ---------------------------------------------------------------------------

export function buildDeliveryReportHTML(
  t: T, subject: Subject, periodo: { name: string; from: string; to: string }, ata: string,
  uds: { id: number; title: string }[], udsGlobal: Set<number>, filas: FilaAlumno[],
): string {
  const celda = (c: CeldaUD | undefined) => !c || c.avaliables === 0
    ? '<td class="n">—</td>'
    : `<td class="n ${nivel(c)}">${pct(c.entregadas, c.avaliables)}%<span class="det">${c.entregadas}/${c.avaliables}</span></td>`;
  const media = (id: number) => sumaCeldas(filas.map(f => f.porUD.get(id)));
  const mediaGlobal = sumaCeldas(filas.map(f => f.global));
  const enGlobal = uds.filter(u => udsGlobal.has(u.id));
  const apaisado = uds.length > 5;

  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(t('informeEntregas.titulo'))}</title>
<style>
  @page { size: A4 ${apaisado ? 'landscape' : 'portrait'}; margin: 14mm; }
  body { font-family: sans-serif; font-size: 9.5pt; color: #1c1917; }
  h1 { font-size: 16pt; margin: 0 0 4px; }
  h2 { font-size: 11.5pt; margin: 16px 0 6px; }
  .meta { color: #57534e; margin: 0 0 2px; }
  table { width: 100%; border-collapse: collapse; margin-top: 4px; }
  thead { display: table-header-group; }
  tr { page-break-inside: avoid; }
  th, td { border: 1px solid #d6d3d1; padding: 3px 5px; text-align: left; }
  th { background: #f5f5f4; font-size: 8.5pt; }
  th.n, td.n { text-align: center; white-space: nowrap; }
  th.g, td.g { background: #f5f5f4; font-weight: bold; }
  .det { display: block; font-size: 7pt; color: #78716c; font-weight: normal; }
  .ok { color: #047857; font-weight: bold; }
  .medio { color: #b45309; font-weight: bold; }
  .ko { color: #be123c; font-weight: bold; }
  tfoot td { font-weight: bold; background: #fafaf9; }
  ul { margin: 4px 0; padding-left: 18px; }
  .nota { color: #57534e; font-size: 8pt; margin-top: 10px; }
</style></head><body>
  <h1>${esc(t('informeEntregas.titulo'))}</h1>
  <p class="meta"><b>${esc(t('seguimento.materia'))}:</b> ${esc(subject.name)}${subject.academicYear ? ` (${esc(subject.academicYear)})` : ''}${(subject.groups || []).length ? ` · ${esc((subject.groups || []).join(', '))}` : ''}</p>
  <p class="meta"><b>${esc(t('informeEntregas.periodo'))}:</b> ${esc(periodo.name)} (${fmtShort(periodo.from)} – ${fmtShort(periodo.to)})</p>
  <p class="meta"><b>${esc(t('seguimento.ataData'))}:</b> ${fmtShort(ata)} · <b>${esc(t('informeEntregas.alumnado'))}:</b> ${filas.length}</p>

  <table>
    <thead><tr>
      <th>${esc(t('seguimento.alumno'))}</th><th>${esc(t('informeEntregas.grupo'))}</th>
      ${uds.map(u => `<th class="n">UD ${u.id}</th>`).join('')}
      <th class="n g">${esc(t('informeEntregas.global'))}</th>
    </tr></thead>
    <tbody>
      ${filas.map(f => `<tr>
        <td>${esc(nomeAlumno(f.alumno))}</td><td>${esc(f.alumno.group || '')}</td>
        ${uds.map(u => celda(f.porUD.get(u.id))).join('')}
        ${celda(f.global).replace('class="n', 'class="n g')}
      </tr>`).join('')}
    </tbody>
    <tfoot><tr>
      <td colspan="2">${esc(t('informeEntregas.mediaClase'))}</td>
      ${uds.map(u => celda(media(u.id))).join('')}
      ${celda(mediaGlobal).replace('class="n', 'class="n g')}
    </tr></tfoot>
  </table>

  <h2>${esc(t('informeEntregas.unidades'))}</h2>
  <ul>${uds.map(u => `<li>UD ${u.id}. ${esc(u.title)}${udsGlobal.has(u.id) ? '' : ` <i>(${esc(t('informeEntregas.foraGlobal'))})</i>`}</li>`).join('')}</ul>

  <p class="nota">${esc(t('informeEntregas.notaGlobal', { uds: enGlobal.map(u => `UD ${u.id}`).join(', ') || '—' }))}
  ${esc(t('seguimento.notaCriterio'))}</p>
</body></html>`;
}

// ---- Compoñente --------------------------------------------------------------------

interface EvalBorrador { name: string; desde: string; ata: string }

// subject é a materia na programación modelo do profesor: os seus logs son os estados
// das sesións e reprogramacións comúns a toda a clase, non os dun alumno en concreto.
export default function InformeEntregas({ subject, onSaveEvaluations, onClose }: {
  subject: Subject;
  onSaveEvaluations: (evals: Evaluation[]) => Promise<void>;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [alumnos, setAlumnos] = useState<EntregasAlumno[]>([]);
  const inicial = useMemo(() => avaliacionsVixentes(t, subject), [subject.config]); // eslint-disable-line react-hooks/exhaustive-deps
  const [evals, setEvals] = useState<Evaluation[]>(inicial.evals);
  const [suxeridas, setSuxeridas] = useState(inicial.suxeridas);
  const [editando, setEditando] = useState<EvalBorrador[] | null>(null);
  const [gardandoEvals, setGardandoEvals] = useState(false);
  const [evalMsg, setEvalMsg] = useState('');
  const hoxe = isoHoxe();
  // Avaliación escollida: a que contén hoxe (ou a última xa comezada); -1 = curso enteiro.
  const [evalIndex, setEvalIndex] = useState<number>(() => {
    const i = inicial.evals.findIndex(e => e.startDate <= hoxe && hoxe <= e.endDate);
    if (i >= 0) return i;
    const pasadas = inicial.evals.map((e, k) => (e.startDate <= hoxe ? k : -1)).filter(k => k >= 0);
    return pasadas.length ? pasadas[pasadas.length - 1] : -1;
  });
  const [excluidas, setExcluidas] = useState<Set<number>>(new Set());
  const [exportando, setExportando] = useState(false);
  const [exportMsg, setExportMsg] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    GetClassDeliveries(subject.id)
      .then(a => { if (!cancelled) setAlumnos(a || []); })
      .catch((e: any) => { if (!cancelled) setError(e?.message || String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [subject.id]);

  const meses = useMemo(() => mesesCurso(subject.config.startDate, subject.config.endDate), [subject.config.startDate, subject.config.endDate]);
  const nomeMes = (mes: string) => new Date(Number(mes.slice(0, 4)), Number(mes.slice(5, 7)) - 1, 1)
    .toLocaleDateString(i18n.language || 'gl', { month: 'long', year: 'numeric' });

  const ev = evalIndex >= 0 ? evals[evalIndex] : undefined;
  const periodo = ev
    ? { name: ev.name, from: ev.startDate, to: ev.endDate }
    : { name: t('informeEntregas.cursoCompleto'), from: subject.config.startDate, to: subject.config.endDate };
  const ata = periodo.to < hoxe ? periodo.to : hoxe;

  const sesions = useMemo(
    () => sesionsImpartidas(subject, subject.logs || {}, periodo.from, ata),
    [subject, periodo.from, ata],
  );
  // UD con sesións impartidas no período, na orde da programación.
  const uds = useMemo(() => {
    const ids = new Set(sesions.map(s => s.unitId));
    return subject.units.filter(u => ids.has(u.id)).map(u => ({ id: u.id, title: u.title }));
  }, [sesions, subject.units]);
  const udsGlobal = useMemo(() => new Set(uds.map(u => u.id).filter(id => !excluidas.has(id))), [uds, excluidas]);
  const filas = useMemo(() => calcularEntregasClase(sesions, alumnos, udsGlobal), [sesions, alumnos, udsGlobal]);
  const mediaGlobal = sumaCeldas(filas.map(f => f.global));

  const toggleUD = (id: number) => setExcluidas(prev => {
    const n = new Set(prev);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  // ---- Edición das avaliacións por meses ----
  const abrirEditor = () => {
    setEvalMsg('');
    setEditando(evals.map(e => ({
      name: e.name,
      desde: meses.includes(e.startDate.slice(0, 7)) ? e.startDate.slice(0, 7) : meses[0],
      ata: meses.includes(e.endDate.slice(0, 7)) ? e.endDate.slice(0, 7) : meses[meses.length - 1],
    })));
  };
  const erroBorrador = (b: EvalBorrador[]): string => {
    for (const e of b) {
      if (!e.name.trim()) return t('informeEntregas.erroNome');
      if (e.desde > e.ata) return t('informeEntregas.erroMeses', { name: e.name });
    }
    return '';
  };
  const gardarEditor = async () => {
    if (!editando) return;
    const err = erroBorrador(editando);
    if (err) { setEvalMsg(err); return; }
    const novas = editando
      .map(b => avaliacionDesdeMeses(b.name.trim(), b.desde, b.ata, subject.config.startDate, subject.config.endDate))
      .sort((a, b) => a.startDate.localeCompare(b.startDate));
    setGardandoEvals(true);
    setEvalMsg('');
    try {
      await onSaveEvaluations(novas);
      setEvals(novas);
      setSuxeridas(false);
      setEditando(null);
      if (evalIndex >= novas.length) setEvalIndex(novas.length - 1);
      setExcluidas(new Set());
    } catch (e: any) {
      setEvalMsg(t('informeEntregas.erroGardarAvaliacions', { error: e?.message || String(e) }));
    } finally {
      setGardandoEvals(false);
    }
  };

  const handleExport = async () => {
    setExportando(true);
    setExportMsg('');
    try {
      const html = buildDeliveryReportHTML(t, subject, periodo, ata, uds, udsGlobal, filas);
      const slug = periodo.name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const path = await ExportDeliveryReportPDF(html, `entregas-${subject.id}-${slug || 'curso'}-${ata}.pdf`);
      if (path) {
        setExportMsg(t('seguimento.gardado', { path }));
        OpenFile(path).catch(() => {});
      }
    } catch (e: any) {
      setExportMsg(t('seguimento.erroExportar', { error: e?.message || String(e) }));
    } finally {
      setExportando(false);
    }
  };

  const Celda = ({ c, bold = false }: { c?: CeldaUD; bold?: boolean }) => {
    if (!c || c.avaliables === 0) return <td className="py-1.5 px-2 text-center text-stone-300">—</td>;
    const n = nivel(c);
    const cor = n === 'ok' ? 'text-emerald-700' : n === 'medio' ? 'text-amber-700' : 'text-rose-700';
    return (
      <td className={`py-1.5 px-2 text-center tabular-nums whitespace-nowrap ${bold ? 'bg-stone-50' : ''}`} title={`${c.entregadas}/${c.avaliables}`}>
        <span className={`font-semibold ${cor}`}>{pct(c.entregadas, c.avaliables)}%</span>
        <span className="block text-[10px] text-stone-400">{c.entregadas}/{c.avaliables}</span>
      </td>
    );
  };

  const selectCls = 'p-1.5 bg-white border border-stone-300 rounded-lg text-sm';

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-6xl overflow-hidden flex flex-col max-h-[92vh]">
        <div className="p-4 border-b border-stone-200 flex justify-between items-center bg-stone-50">
          <div>
            <h3 className="font-bold text-lg text-stone-900 flex items-center gap-2">
              <Users className="w-5 h-5" /> {t('informeEntregas.titulo')}
            </h3>
            <p className="text-xs text-stone-500 mt-0.5">
              {subject.name} · {periodo.name} ({fmtShort(periodo.from)} – {fmtShort(periodo.to)}) · {t('seguimento.ataData')} {fmtShort(ata)}
            </p>
          </div>
          <button onClick={onClose} className="p-2 text-stone-400 hover:text-stone-600 rounded-lg hover:bg-stone-200 transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 overflow-y-auto flex-1 flex flex-col gap-4">
          {/* Período e avaliacións (por meses) */}
          <div className="rounded-xl border border-stone-200 p-3 flex flex-col gap-3">
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1 text-xs font-medium text-stone-600">
                {t('informeEntregas.periodo')}
                <select value={evalIndex} onChange={e => { setEvalIndex(Number(e.target.value)); setExcluidas(new Set()); }} className={selectCls}>
                  {evals.map((e, i) => (
                    <option key={i} value={i}>{e.name} ({nomeMes(e.startDate.slice(0, 7))} – {nomeMes(e.endDate.slice(0, 7))})</option>
                  ))}
                  <option value={-1}>{t('informeEntregas.cursoCompleto')}</option>
                </select>
              </label>
              {!editando && (
                <button onClick={abrirEditor}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-stone-100 border border-stone-300 text-stone-700 hover:bg-stone-200 rounded-lg font-medium">
                  <Pencil className="w-4 h-4" /> {t('informeEntregas.definirAvaliacions')}
                </button>
              )}
              {suxeridas && !editando && (
                <span className="text-xs text-amber-700">{t('informeEntregas.avaliacionsSuxeridas')}</span>
              )}
            </div>

            {editando && (
              <div className="flex flex-col gap-2 rounded-lg bg-stone-50 border border-stone-200 p-3">
                <p className="text-xs text-stone-500">{t('informeEntregas.axudaAvaliacions')}</p>
                {editando.map((b, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-2">
                    <input value={b.name} onChange={e => setEditando(editando.map((x, k) => k === i ? { ...x, name: e.target.value } : x))}
                      placeholder={t('informeEntregas.nomeAvaliacion')} className="p-1.5 bg-white border border-stone-300 rounded-lg text-sm w-44" />
                    <span className="text-xs text-stone-500">{t('informeEntregas.desde')}</span>
                    <select value={b.desde} onChange={e => setEditando(editando.map((x, k) => k === i ? { ...x, desde: e.target.value } : x))} className={selectCls}>
                      {meses.map(m => <option key={m} value={m}>{nomeMes(m)}</option>)}
                    </select>
                    <span className="text-xs text-stone-500">{t('informeEntregas.ata')}</span>
                    <select value={b.ata} onChange={e => setEditando(editando.map((x, k) => k === i ? { ...x, ata: e.target.value } : x))} className={selectCls}>
                      {meses.map(m => <option key={m} value={m}>{nomeMes(m)}</option>)}
                    </select>
                    <button onClick={() => setEditando(editando.filter((_, k) => k !== i))} title={t('informeEntregas.eliminarAvaliacion')}
                      className="p-1.5 text-stone-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))}
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <button onClick={() => {
                    const ult = editando[editando.length - 1];
                    const seguinte = ult ? meses[Math.min(meses.indexOf(ult.ata) + 1, meses.length - 1)] : meses[0];
                    setEditando([...editando, { name: t('informeEntregas.avaliacionN', { n: editando.length + 1 }), desde: seguinte, ata: meses[meses.length - 1] }]);
                  }} className="flex items-center gap-1 px-2.5 py-1.5 text-sm bg-white border border-stone-300 text-stone-700 hover:bg-stone-100 rounded-lg">
                    <Plus className="w-4 h-4" /> {t('informeEntregas.engadirAvaliacion')}
                  </button>
                  <span className="flex-1" />
                  <button onClick={() => { setEditando(null); setEvalMsg(''); }} className="px-3 py-1.5 text-sm text-stone-600 hover:bg-stone-200 rounded-lg">
                    {t('app.cancelar')}
                  </button>
                  <button onClick={gardarEditor} disabled={gardandoEvals || editando.length === 0}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-stone-900 text-white hover:bg-stone-800 rounded-lg font-medium disabled:opacity-50">
                    {gardandoEvals ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} {t('informeEntregas.gardarAvaliacions')}
                  </button>
                </div>
              </div>
            )}
            {evalMsg && <p className="text-xs text-rose-600">{evalMsg}</p>}

            {uds.length > 0 && (
              <div className="flex flex-col gap-1">
                <span className="text-xs font-medium text-stone-600">{t('informeEntregas.udsGlobal')}</span>
                <div className="flex flex-wrap gap-1.5">
                  {uds.map(u => (
                    <label key={u.id} title={u.title}
                      className={`flex items-center gap-1.5 px-2 py-1 rounded-lg border text-xs cursor-pointer ${udsGlobal.has(u.id) ? 'bg-emerald-50 border-emerald-300 text-emerald-800' : 'bg-white border-stone-200 text-stone-400'}`}>
                      <input type="checkbox" checked={udsGlobal.has(u.id)} onChange={() => toggleUD(u.id)} className="w-3.5 h-3.5 accent-emerald-600" />
                      UD {u.id}. <span className="max-w-[180px] truncate">{u.title}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>

          {loading ? (
            <div className="flex items-center gap-2 text-stone-500 text-sm"><Loader2 className="w-4 h-4 animate-spin" /> {t('app.cargando')}</div>
          ) : error ? (
            <div className="text-sm text-rose-600">{error}</div>
          ) : alumnos.length === 0 ? (
            <div className="text-sm text-stone-500">{t('informeEntregas.senAlumnado')}</div>
          ) : uds.length === 0 ? (
            <div className="text-sm text-stone-500">{t('informeEntregas.senSesions')}</div>
          ) : (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="rounded-xl border border-stone-200 p-3">
                  <div className="text-xs text-stone-500">{t('informeEntregas.mediaGlobal')}</div>
                  <div className="text-2xl font-bold text-emerald-700 tabular-nums">{mediaGlobal.avaliables > 0 ? `${pct(mediaGlobal.entregadas, mediaGlobal.avaliables)}%` : '—'}</div>
                </div>
                <div className="rounded-xl border border-stone-200 p-3">
                  <div className="text-xs text-stone-500">{t('informeEntregas.alumnado')}</div>
                  <div className="text-2xl font-bold text-stone-800 tabular-nums">{alumnos.length}</div>
                </div>
                <div className="rounded-xl border border-stone-200 p-3">
                  <div className="text-xs text-stone-500">{t('informeEntregas.sesionsAvaliables')}</div>
                  <div className="text-2xl font-bold text-stone-800 tabular-nums">{sesions.filter(s => !s.exame).length}</div>
                </div>
              </div>

              <div className="overflow-x-auto border border-stone-200 rounded-xl">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-stone-500 border-b border-stone-200 bg-stone-50">
                      <th className="py-2 px-2">{t('seguimento.alumno')}</th>
                      <th className="py-2 px-2">{t('informeEntregas.grupo')}</th>
                      {uds.map(u => (
                        <th key={u.id} className={`py-2 px-2 text-center ${udsGlobal.has(u.id) ? '' : 'text-stone-300'}`} title={u.title}>UD {u.id}</th>
                      ))}
                      <th className="py-2 px-2 text-center bg-stone-100">{t('informeEntregas.global')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filas.map(f => (
                      <tr key={f.alumno.username} className="border-b border-stone-100">
                        <td className="py-1.5 px-2 font-medium whitespace-nowrap">{nomeAlumno(f.alumno)}</td>
                        <td className="py-1.5 px-2 text-xs text-stone-500">{f.alumno.group}</td>
                        {uds.map(u => <Celda key={u.id} c={f.porUD.get(u.id)} />)}
                        <Celda c={f.global} bold />
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="bg-stone-50 font-semibold border-t border-stone-200">
                      <td className="py-1.5 px-2" colSpan={2}>{t('informeEntregas.mediaClase')}</td>
                      {uds.map(u => <Celda key={u.id} c={sumaCeldas(filas.map(f => f.porUD.get(u.id)))} />)}
                      <Celda c={mediaGlobal} bold />
                    </tr>
                  </tfoot>
                </table>
              </div>

              <p className="text-xs text-stone-500">
                {t('informeEntregas.notaGlobal', { uds: uds.filter(u => udsGlobal.has(u.id)).map(u => `UD ${u.id}`).join(', ') || '—' })}{' '}
                {t('seguimento.notaCriterio')}
              </p>
            </>
          )}
          {exportMsg && <div className="text-sm text-stone-700">{exportMsg}</div>}
        </div>

        <div className="p-3 border-t border-stone-200 bg-stone-50 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-stone-600 font-medium hover:bg-stone-200 rounded-lg transition-colors">
            {t('app.pechar')}
          </button>
          <button onClick={handleExport} disabled={loading || !!error || exportando || alumnos.length === 0 || uds.length === 0}
            className="px-4 py-2 bg-stone-900 text-white font-medium hover:bg-stone-800 rounded-lg transition-colors flex items-center gap-2 disabled:opacity-50">
            {exportando ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />} {t('seguimento.exportarPDF')}
          </button>
        </div>
      </div>
    </div>
  );
}
