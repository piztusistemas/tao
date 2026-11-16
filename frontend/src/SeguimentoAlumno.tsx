// SeguimentoAlumno.tsx — informe de seguimento dun alumno para o profesorado.
//
// Cruza, para cada sesión de clase da materia ata hoxe, tres fontes:
//   - a programación (calendario + UD: generateMonthlySchedule, coas reprogramacións
//     do profesor xa superpostas nos logs do alumno — ver handleSelectStudent en App.tsx),
//   - o rexistro de conexións do alumno (GetStudentConnections, tao/conexions.go),
//   - as súas entregas: práctica escrita nese día (logs[data].content) e/ou ficheiros de
//     traballo subidos a esa sesión (ListStudentWorkFileDates, tao/traballos.go).
// e resume, por unidade didáctica, a porcentaxe de sesións con e sen entrega.
//
// As sesións de exame non contan no cálculo de entregas (non se espera tarefa), aínda
// que se listan. Os días de folga/saída/ausencia non consumen sesión e non aparecen.
import { Fragment, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Loader2, Download, ClipboardList, Check, Minus } from 'lucide-react';
import { Subject, DayStatus } from './types';
import { generateMonthlySchedule } from './data';
import { GetStudentConnections, ListStudentWorkFileDates, ExportTrackingReportPDF, OpenFile } from '../bindings/tao/app';
import { ConexionRexistro } from '../bindings/tao/models';
import { esc, fmtShort } from './reportHtml';

type T = (key: string, opts?: Record<string, any>) => string;

export interface SesionSeguimento {
  date: string;
  unitId: number;
  sessionIndex: number;
  status: DayStatus;
  exame: boolean;
  conexion?: ConexionRexistro;
  practica: boolean;
  ficheiros: boolean;
  entregou: boolean;
}

export interface ResumoUD {
  unitId: number;
  title: string;
  totalSesions: number;    // sesións programadas da UD (curso enteiro)
  sesionsPasadas: number;  // xa impartidas (ata hoxe), exames incluídos
  avaliables: number;      // sesións pasadas sen exame: o denominador das entregas
  entregadas: number;
  conectado: number;       // sesións pasadas con conexión ese día
  sesions: SesionSeguimento[];
}

const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : 0);

function isoHoxe(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// calcularSeguimento é puro (sen chamadas ao backend) para poder reutilizalo tanto na
// vista como no HTML do PDF.
export function calcularSeguimento(
  subject: Subject,
  conexions: ConexionRexistro[],
  workDates: Set<string>,
  ata: string,
): { unidades: ResumoUD[]; conexionsPorData: Map<string, ConexionRexistro> } {
  const conexionsPorData = new Map(conexions.map(c => [c.data, c]));
  const { months } = generateMonthlySchedule(subject.config, subject.units, subject.logs || {});
  const unidades = new Map<number, ResumoUD>();
  for (const u of subject.units) {
    unidades.set(u.id, {
      unitId: u.id, title: u.title, totalSesions: u.sessions,
      sesionsPasadas: 0, avaliables: 0, entregadas: 0, conectado: 0, sesions: [],
    });
  }
  for (const m of months) {
    for (const d of m.days) {
      if (!d.unit || d.dateString > ata) continue;
      const r = unidades.get(d.unit.id);
      if (!r) continue;
      const log = subject.logs?.[d.dateString];
      const status = (log?.status || 'lectivo') as DayStatus;
      const exame = status === 'exame';
      const practica = !!(log?.content && log.content.trim());
      const ficheiros = workDates.has(d.dateString);
      const conexion = conexionsPorData.get(d.dateString);
      const entregou = practica || ficheiros;
      r.sesions.push({
        date: d.dateString, unitId: d.unit.id, sessionIndex: d.sessionIndex || 0, status, exame,
        conexion, practica, ficheiros, entregou,
      });
      r.sesionsPasadas++;
      if (conexion) r.conectado++;
      if (!exame) {
        r.avaliables++;
        if (entregou) r.entregadas++;
      }
    }
  }
  return { unidades: [...unidades.values()], conexionsPorData };
}

function totais(unidades: ResumoUD[]) {
  return unidades.reduce(
    (acc, u) => ({
      sesionsPasadas: acc.sesionsPasadas + u.sesionsPasadas,
      avaliables: acc.avaliables + u.avaliables,
      entregadas: acc.entregadas + u.entregadas,
      conectado: acc.conectado + u.conectado,
    }),
    { sesionsPasadas: 0, avaliables: 0, entregadas: 0, conectado: 0 },
  );
}

// buildTrackingHTML: documento autocontido (sen recursos externos) que
// ExportTrackingReportPDF (tao/conexions.go) converte en PDF.
export function buildTrackingHTML(
  t: T, subject: Subject, studentLabel: string, group: string,
  unidades: ResumoUD[], conexions: ConexionRexistro[], ata: string,
): string {
  const tot = totais(unidades);
  const sesionDates = new Set(unidades.flatMap(u => u.sesions.map(s => s.date)));
  const foraSesion = conexions.filter(c => c.data <= ata && !sesionDates.has(c.data)).length;
  const primeiroRexistro = conexions[0]?.data;
  const si = t('seguimento.si'), non = t('seguimento.non');

  const filaResumo = (u: ResumoUD) => `
    <tr>
      <td>UD ${u.unitId}. ${esc(u.title)}</td>
      <td class="n">${u.sesionsPasadas} / ${u.totalSesions}</td>
      <td class="n">${u.conectado} (${pct(u.conectado, u.sesionsPasadas)}%)</td>
      <td class="n ok">${u.entregadas} (${pct(u.entregadas, u.avaliables)}%)</td>
      <td class="n ko">${u.avaliables - u.entregadas} (${u.avaliables > 0 ? 100 - pct(u.entregadas, u.avaliables) : 0}%)</td>
    </tr>`;

  const detalle = unidades.filter(u => u.sesions.length > 0).map(u => `
    <h3>UD ${u.unitId}. ${esc(u.title)}</h3>
    <table>
      <thead><tr>
        <th>${esc(t('seguimento.data'))}</th><th>${esc(t('seguimento.sesion'))}</th>
        <th>${esc(t('seguimento.conexion'))}</th><th>${esc(t('seguimento.practica'))}</th>
        <th>${esc(t('seguimento.ficheiros'))}</th><th>${esc(t('seguimento.entrega'))}</th>
      </tr></thead>
      <tbody>
      ${u.sesions.map(s => `
        <tr>
          <td>${fmtShort(s.date)}</td>
          <td class="n">${s.sessionIndex}/${u.totalSesions}${s.exame ? ` · ${esc(t('seguimento.exame'))}` : ''}</td>
          <td>${s.conexion ? `${si}${s.conexion.primeira ? ` (${esc(s.conexion.primeira)})` : ''}` : non}</td>
          <td>${s.practica ? si : non}</td>
          <td>${s.ficheiros ? si : non}</td>
          <td class="${s.exame ? '' : s.entregou ? 'ok' : 'ko'}">${s.exame ? '—' : s.entregou ? si : non}</td>
        </tr>`).join('')}
      </tbody>
    </table>`).join('');

  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(t('seguimento.titulo'))}</title>
<style>
  @page { size: A4; margin: 16mm; }
  body { font-family: sans-serif; font-size: 10pt; color: #1c1917; }
  h1 { font-size: 16pt; margin: 0 0 4px; }
  h2 { font-size: 12pt; margin: 18px 0 6px; }
  h3 { font-size: 10.5pt; margin: 14px 0 4px; }
  .meta { color: #57534e; margin: 0 0 2px; }
  table { width: 100%; border-collapse: collapse; margin-top: 4px; page-break-inside: auto; }
  tr { page-break-inside: avoid; }
  th, td { border: 1px solid #d6d3d1; padding: 3px 6px; text-align: left; }
  th { background: #f5f5f4; }
  td.n { text-align: right; white-space: nowrap; }
  .ok { color: #047857; font-weight: bold; }
  .ko { color: #be123c; font-weight: bold; }
  tfoot td { font-weight: bold; background: #fafaf9; }
  .nota { color: #57534e; font-size: 8.5pt; margin-top: 10px; }
</style></head><body>
  <h1>${esc(t('seguimento.titulo'))}</h1>
  <p class="meta"><b>${esc(t('seguimento.alumno'))}:</b> ${esc(studentLabel)}${group ? ` · ${esc(group)}` : ''}</p>
  <p class="meta"><b>${esc(t('seguimento.materia'))}:</b> ${esc(subject.name)}${subject.academicYear ? ` (${esc(subject.academicYear)})` : ''}</p>
  <p class="meta"><b>${esc(t('seguimento.ataData'))}:</b> ${fmtShort(ata)}</p>

  <h2>${esc(t('seguimento.resumoPorUD'))}</h2>
  <table>
    <thead><tr>
      <th>${esc(t('seguimento.unidade'))}</th><th>${esc(t('seguimento.sesionsImpartidas'))}</th>
      <th>${esc(t('seguimento.diasConectado'))}</th><th>${esc(t('seguimento.conEntrega'))}</th>
      <th>${esc(t('seguimento.senEntrega'))}</th>
    </tr></thead>
    <tbody>${unidades.filter(u => u.sesionsPasadas > 0).map(filaResumo).join('')}</tbody>
    <tfoot><tr>
      <td>${esc(t('seguimento.total'))}</td>
      <td class="n">${tot.sesionsPasadas}</td>
      <td class="n">${tot.conectado} (${pct(tot.conectado, tot.sesionsPasadas)}%)</td>
      <td class="n">${tot.entregadas} (${pct(tot.entregadas, tot.avaliables)}%)</td>
      <td class="n">${tot.avaliables - tot.entregadas} (${tot.avaliables > 0 ? 100 - pct(tot.entregadas, tot.avaliables) : 0}%)</td>
    </tr></tfoot>
  </table>
  <p class="meta">${esc(t('seguimento.conexionsTotais', { count: conexions.filter(c => c.data <= ata).length, fora: foraSesion }))}</p>

  <h2>${esc(t('seguimento.detalle'))}</h2>
  ${detalle || `<p>${esc(t('seguimento.senSesions'))}</p>`}

  <p class="nota">${esc(t('seguimento.notaCriterio'))}
  ${esc(primeiroRexistro ? t('seguimento.notaRexistroDesde', { data: fmtShort(primeiroRexistro) }) : t('seguimento.notaSenRexistro'))}</p>
</body></html>`;
}

export default function SeguimentoAlumno({ subject, username, studentLabel, group, onClose }: {
  subject: Subject; username: string; studentLabel: string; group: string; onClose: () => void;
}) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [conexions, setConexions] = useState<ConexionRexistro[]>([]);
  const [workDates, setWorkDates] = useState<Set<string>>(new Set());
  const [aberta, setAberta] = useState<number | null>(null);
  const [exportando, setExportando] = useState(false);
  const [exportMsg, setExportMsg] = useState('');
  const ata = isoHoxe();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    Promise.all([GetStudentConnections(username), ListStudentWorkFileDates(username, subject.id)])
      .then(([c, w]) => {
        if (cancelled) return;
        setConexions(c || []);
        setWorkDates(new Set(w || []));
      })
      .catch((e: any) => { if (!cancelled) setError(e?.message || String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [username, subject.id]);

  const { unidades } = useMemo(
    () => calcularSeguimento(subject, conexions, workDates, ata),
    [subject, conexions, workDates, ata],
  );
  const tot = totais(unidades);
  const primeiroRexistro = conexions[0]?.data;

  const handleExport = async () => {
    setExportando(true);
    setExportMsg('');
    try {
      const html = buildTrackingHTML(t, subject, studentLabel, group, unidades, conexions, ata);
      const nome = `seguimento-${username}-${subject.id}-${ata}.pdf`;
      const path = await ExportTrackingReportPDF(html, nome);
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

  const Barra = ({ ok, total }: { ok: number; total: number }) => {
    const p = pct(ok, total);
    return (
      <div className="flex items-center gap-2 min-w-[140px]">
        <div className="flex-1 h-2.5 rounded-full bg-rose-200 overflow-hidden" title={`${p}%`}>
          <div className="h-full bg-emerald-500" style={{ width: `${total > 0 ? p : 0}%` }} />
        </div>
        <span className="text-xs tabular-nums text-stone-600 w-9 text-right">{total > 0 ? `${p}%` : '—'}</span>
      </div>
    );
  };

  const SiNon = ({ v }: { v: boolean }) => v
    ? <Check className="w-4 h-4 text-emerald-600" aria-label={t('seguimento.si')} />
    : <Minus className="w-4 h-4 text-stone-300" aria-label={t('seguimento.non')} />;

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-4xl overflow-hidden flex flex-col max-h-[90vh]">
        <div className="p-4 border-b border-stone-200 flex justify-between items-center bg-stone-50">
          <div>
            <h3 className="font-bold text-lg text-stone-900 flex items-center gap-2">
              <ClipboardList className="w-5 h-5" /> {t('seguimento.titulo')}
            </h3>
            <p className="text-xs text-stone-500 mt-0.5">
              {studentLabel}{group ? ` · ${group}` : ''} · {subject.name} · {t('seguimento.ataData')} {fmtShort(ata)}
            </p>
          </div>
          <button onClick={onClose} className="p-2 text-stone-400 hover:text-stone-600 rounded-lg hover:bg-stone-200 transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 overflow-y-auto flex-1 flex flex-col gap-5">
          {loading ? (
            <div className="flex items-center gap-2 text-stone-500 text-sm"><Loader2 className="w-4 h-4 animate-spin" /> {t('app.cargando')}</div>
          ) : error ? (
            <div className="text-sm text-rose-600">{error}</div>
          ) : (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="rounded-xl border border-stone-200 p-3">
                  <div className="text-xs text-stone-500">{t('seguimento.conEntrega')}</div>
                  <div className="text-2xl font-bold text-emerald-700 tabular-nums">{tot.avaliables > 0 ? `${pct(tot.entregadas, tot.avaliables)}%` : '—'}</div>
                  <div className="text-xs text-stone-500">{t('seguimento.deSesions', { n: tot.entregadas, total: tot.avaliables })}</div>
                </div>
                <div className="rounded-xl border border-stone-200 p-3">
                  <div className="text-xs text-stone-500">{t('seguimento.senEntrega')}</div>
                  <div className="text-2xl font-bold text-rose-700 tabular-nums">{tot.avaliables > 0 ? `${100 - pct(tot.entregadas, tot.avaliables)}%` : '—'}</div>
                  <div className="text-xs text-stone-500">{t('seguimento.deSesions', { n: tot.avaliables - tot.entregadas, total: tot.avaliables })}</div>
                </div>
                <div className="rounded-xl border border-stone-200 p-3">
                  <div className="text-xs text-stone-500">{t('seguimento.diasConectado')}</div>
                  <div className="text-2xl font-bold text-stone-800 tabular-nums">{tot.sesionsPasadas > 0 ? `${pct(tot.conectado, tot.sesionsPasadas)}%` : '—'}</div>
                  <div className="text-xs text-stone-500">{t('seguimento.deSesions', { n: tot.conectado, total: tot.sesionsPasadas })}</div>
                </div>
              </div>

              <div>
                <h4 className="font-semibold text-stone-800 mb-2">{t('seguimento.resumoPorUD')}</h4>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs text-stone-500 border-b border-stone-200">
                        <th className="py-2 pr-2">{t('seguimento.unidade')}</th>
                        <th className="py-2 px-2 text-right">{t('seguimento.sesionsImpartidas')}</th>
                        <th className="py-2 px-2 text-right">{t('seguimento.diasConectado')}</th>
                        <th className="py-2 px-2">{t('seguimento.entregas')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {unidades.map(u => (
                        <Fragment key={u.unitId}>
                          <tr
                            onClick={() => u.sesions.length > 0 && setAberta(aberta === u.unitId ? null : u.unitId)}
                            className={`border-b border-stone-100 ${u.sesions.length > 0 ? 'cursor-pointer hover:bg-stone-50' : 'text-stone-400'}`}
                            title={u.sesions.length > 0 ? t('seguimento.verDetalle') : ''}>
                            <td className="py-2 pr-2 font-medium">UD {u.unitId}. {u.title}</td>
                            <td className="py-2 px-2 text-right tabular-nums">{u.sesionsPasadas} / {u.totalSesions}</td>
                            <td className="py-2 px-2 text-right tabular-nums">{u.sesionsPasadas > 0 ? `${u.conectado} (${pct(u.conectado, u.sesionsPasadas)}%)` : '—'}</td>
                            <td className="py-2 px-2">
                              {u.avaliables > 0 ? (
                                <div className="flex items-center gap-3">
                                  <Barra ok={u.entregadas} total={u.avaliables} />
                                  <span className="text-xs text-stone-500 whitespace-nowrap">
                                    {t('seguimento.entregadasNon', { si: u.entregadas, non: u.avaliables - u.entregadas })}
                                  </span>
                                </div>
                              ) : <span className="text-xs">{u.sesionsPasadas > 0 ? t('seguimento.soExames') : t('seguimento.senImpartir')}</span>}
                            </td>
                          </tr>
                          {aberta === u.unitId && (
                            <tr>
                              <td colSpan={4} className="bg-stone-50 px-3 py-2">
                                <table className="w-full text-xs">
                                  <thead>
                                    <tr className="text-left text-stone-500">
                                      <th className="py-1">{t('seguimento.data')}</th>
                                      <th className="py-1">{t('seguimento.sesion')}</th>
                                      <th className="py-1">{t('seguimento.conexion')}</th>
                                      <th className="py-1">{t('seguimento.practica')}</th>
                                      <th className="py-1">{t('seguimento.ficheiros')}</th>
                                      <th className="py-1">{t('seguimento.entrega')}</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {u.sesions.map(s => (
                                      <tr key={s.date} className="border-t border-stone-200">
                                        <td className="py-1 tabular-nums">{fmtShort(s.date)}</td>
                                        <td className="py-1 tabular-nums">{s.sessionIndex}/{u.totalSesions}{s.exame ? ` · ${t('seguimento.exame')}` : ''}</td>
                                        <td className="py-1">
                                          {s.conexion
                                            ? <span className="flex items-center gap-1"><Check className="w-4 h-4 text-emerald-600" />{s.conexion.primeira}{s.conexion.equipos.length ? ` · ${s.conexion.equipos.join(', ')}` : ''}</span>
                                            : <Minus className="w-4 h-4 text-stone-300" />}
                                        </td>
                                        <td className="py-1"><SiNon v={s.practica} /></td>
                                        <td className="py-1"><SiNon v={s.ficheiros} /></td>
                                        <td className="py-1">
                                          {s.exame ? <span className="text-stone-400">—</span>
                                            : s.entregou ? <span className="text-emerald-700 font-semibold">{t('seguimento.si')}</span>
                                            : <span className="text-rose-700 font-semibold">{t('seguimento.non')}</span>}
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <p className="text-xs text-stone-500">
                {t('seguimento.notaCriterio')}{' '}
                {primeiroRexistro ? t('seguimento.notaRexistroDesde', { data: fmtShort(primeiroRexistro) }) : t('seguimento.notaSenRexistro')}
              </p>
            </>
          )}
          {exportMsg && <div className="text-sm text-stone-700">{exportMsg}</div>}
        </div>

        <div className="p-3 border-t border-stone-200 bg-stone-50 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-stone-600 font-medium hover:bg-stone-200 rounded-lg transition-colors">
            {t('app.pechar')}
          </button>
          <button onClick={handleExport} disabled={loading || !!error || exportando}
            className="px-4 py-2 bg-stone-900 text-white font-medium hover:bg-stone-800 rounded-lg transition-colors flex items-center gap-2 disabled:opacity-50">
            {exportando ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />} {t('seguimento.exportarPDF')}
          </button>
        </div>
      </div>
    </div>
  );
}
