import React, { useEffect, useState } from 'react';
import { Pause, Play, RefreshCw, Trash2, XCircle } from 'lucide-react';
import type { LanguageCode, OperationLog, TranslationJob } from '../types/domain';
import { tFor } from '../i18n/translations';
import { api } from '../utils/api';
import { useAppLifecycle } from '../utils/appLifecycle';
import { formatPageStageLabel } from '../utils/persistenceUtils';

interface JobsViewProps {
  lang: LanguageCode;
  onOpenChapter: (chapterId: string) => void;
}

export const JobsView: React.FC<JobsViewProps> = ({ lang, onOpenChapter }) => {
  const t = tFor(lang);
  const [jobs, setJobs] = useState<TranslationJob[]>([]);
  const [logs, setLogs] = useState<OperationLog[]>([]);

  const fetchJobs = async () => {
    const res = await api.getJobs();
    setJobs(res.jobs);
    setLogs(res.logs);
  };

  useEffect(() => {
    void fetchJobs();
    const timer = setInterval(() => void fetchJobs(), 2500);
    return () => clearInterval(timer);
  }, []);

  useAppLifecycle({
    onResume: () => {
      void fetchJobs();
    },
  });

  const handleAction = async (
    jobId: string,
    action: 'pause' | 'resume' | 'cancel' | 'retry_failed'
  ) => {
    await api.controlJob(jobId, action);
    await fetchJobs();
  };

  return (
    <div className="max-w-6xl w-full mx-auto px-4 lg:px-8 py-6 space-y-8">
      <div className="pb-5 border-b border-slate-200 dark:border-slate-800">
        <h1 className="text-2xl font-bold text-slate-900 dark:text-white">{t.jobs.title}</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">{t.jobs.subtitle}</p>
      </div>

      {/* Batch Jobs */}
      <section className="space-y-4">
        <h2 className="text-base font-bold text-slate-800 dark:text-slate-100">
          {t.jobs.activeJobs}
        </h2>

        {jobs.length === 0 ? (
          <div className="faqqa-card p-8 rounded-[22px] text-center text-sm font-bold text-[#524E46] dark:text-slate-300">
            {t.jobs.noJobs}
          </div>
        ) : (
          <div className="space-y-4">
            {jobs.map((job) => {
              const states = Object.entries(job.pageStates || {});
              const runningCount = states.filter(([, st]) => st === 'running').length;
              const queuedCount = states.filter(([, st]) => st === 'queued').length;
              return (
                <div
                  key={job.id}
                  className="faqqa-card p-4 sm:p-5 rounded-[22px] space-y-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="space-y-0.5">
                      <button
                        type="button"
                        onClick={() => onOpenChapter(job.chapterId)}
                        className="font-display-comic text-base font-black text-[#111111] dark:text-[#FFFDF9] hover:text-[#EA3829] dark:hover:text-[#FFE01B] cursor-pointer"
                      >
                        {job.chapterTitle}
                      </button>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-bold text-[#524E46] dark:text-slate-400 font-mono-tabular">
                        <span>{job.status.toUpperCase()}</span>
                        <span>
                          {job.completedPages}/{job.totalPages} · {job.progress}%
                        </span>
                        {typeof job.totalBatches === 'number' && job.totalBatches > 0 && (
                          <span>
                            {t.jobs.batchLabel} {job.currentBatch || 1}/{job.totalBatches}
                          </span>
                        )}
                        {runningCount > 0 && (
                          <span className="text-[#EA3829] dark:text-[#FFE01B] font-extrabold">
                            {runningCount} {t.jobs.inProgressPages}
                          </span>
                        )}
                        {queuedCount > 0 && (
                          <span>
                            {queuedCount} {t.jobs.remainingPages}
                          </span>
                        )}
                        {job.activeProvider && (
                          <span dir="ltr" className="text-[#111111] dark:text-slate-300">
                            {job.activeProvider}
                            {job.activeModel ? ` · ${job.activeModel}` : ''}
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      {(job.status === 'running' || job.status === 'queued') && (
                        <button
                          type="button"
                          onClick={() => void handleAction(job.id, 'pause')}
                          className="inline-flex items-center gap-1 px-3 py-1.5 rounded-xl border-2 border-[#111111]/30 dark:border-white/25 text-xs font-extrabold whitespace-nowrap shrink-0 cursor-pointer"
                        >
                          <Pause className="w-3.5 h-3.5" />
                          <span>{t.jobs.pause}</span>
                        </button>
                      )}
                      {job.status === 'paused' && (
                        <button
                          type="button"
                          onClick={() => void handleAction(job.id, 'resume')}
                          className="faqqa-btn-yellow inline-flex items-center gap-1 px-3 py-1.5 rounded-xl text-xs font-black whitespace-nowrap shrink-0 cursor-pointer"
                        >
                          <Play className="w-3.5 h-3.5" />
                          <span>{t.jobs.resume}</span>
                        </button>
                      )}
                      {job.failedPages > 0 && (
                        <button
                          type="button"
                          onClick={() => void handleAction(job.id, 'retry_failed')}
                          className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-amber-500 text-amber-600 text-xs font-medium whitespace-nowrap shrink-0 cursor-pointer"
                        >
                          <RefreshCw className="w-3.5 h-3.5" />
                          <span>{t.jobs.retryFailed}</span>
                        </button>
                      )}
                      {(job.status === 'running' || job.status === 'paused' || job.status === 'queued') && (
                        <button
                          type="button"
                          onClick={() => void handleAction(job.id, 'cancel')}
                          className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-rose-300 text-rose-600 text-xs font-medium whitespace-nowrap shrink-0 cursor-pointer"
                        >
                          <XCircle className="w-3.5 h-3.5" />
                          <span>{t.jobs.cancelJob}</span>
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="w-full h-2.5 rounded-full bg-[#FAF5E8] dark:bg-[#111216] border border-[#111111]/30 overflow-hidden">
                    <div
                      className={`h-full transition-all ${
                        job.status === 'failed'
                          ? 'bg-[#EA3829]'
                          : job.status === 'paused'
                          ? 'bg-amber-500'
                          : 'bg-[#FFE01B]'
                      }`}
                      style={{ width: `${job.progress}%` }}
                    />
                  </div>

                  {states.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1 pt-1">
                      {states.slice(0, 60).map(([pid, st], idx) => {
                        const stage = job.pageStages?.[pid];
                        const stageLabel = stage ? ` · ${formatPageStageLabel(lang, stage)}` : '';
                        return (
                        <span
                          key={pid}
                          title={`#${idx + 1}: ${st}${stageLabel}`}
                          className={`inline-flex items-center justify-center min-w-[24px] h-5 px-1 rounded text-[10px] font-mono-tabular border ${
                            st === 'completed' || st === 'skipped'
                              ? 'border-emerald-400/80 bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-300'
                              : st === 'running'
                              ? 'border-[#111111] bg-[#FFE01B] text-[#111111] font-black'
                              : st === 'failed'
                              ? 'border-[#EA3829] bg-[#EA3829]/10 dark:bg-rose-950/40 text-[#EA3829] dark:text-rose-300'
                              : 'border-[#111111]/20 dark:border-slate-700 text-[#524E46] dark:text-slate-400'
                          }`}
                        >
                          {idx + 1}
                        </span>
                        );
                      })}
                      {states.length > 60 && (
                        <span className="text-[10px] font-mono-tabular text-slate-400 px-1">
                          +{states.length - 60}
                        </span>
                      )}
                    </div>
                  )}

                  {job.errorMessage && (
                    <p className="text-xs text-rose-600 dark:text-rose-400">{job.errorMessage}</p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Operation & Error Logs */}
      <section className="space-y-3 pt-4 border-t border-slate-200 dark:border-slate-800">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-bold text-slate-800 dark:text-slate-100">{t.jobs.logs}</h2>
          <button
            type="button"
            onClick={async () => {
              await api.clearLogs();
              await fetchJobs();
            }}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs text-slate-600 dark:text-slate-300 cursor-pointer"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>{t.jobs.clearLogs}</span>
          </button>
        </div>

        <div className="faqqa-card rounded-[22px] divide-y divide-[#111111]/10 dark:divide-white/10 max-h-96 overflow-y-auto">
          {logs.map((log) => (
            <div key={log.id} className="px-4 py-2.5 flex items-start justify-between gap-4 text-xs">
              <div className="space-y-0.5">
                <span
                  className={`font-mono-tabular font-extrabold ${
                    log.level === 'error'
                      ? 'text-[#EA3829]'
                      : log.level === 'warn'
                      ? 'text-amber-600'
                      : 'text-[#111111] dark:text-[#FFE01B]'
                  }`}
                >
                  {log.action}
                </span>
                <p className="text-[#333333] dark:text-slate-300">{log.message}</p>
              </div>
              <span className="font-mono-tabular text-[#524E46] dark:text-slate-400 shrink-0">
                {new Date(log.timestamp).toLocaleTimeString()}
              </span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
};
