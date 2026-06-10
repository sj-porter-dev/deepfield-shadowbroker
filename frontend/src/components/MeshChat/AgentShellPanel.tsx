'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from 'lucide-react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { resolveAgentShellWsUrl } from '@/lib/agentShellWs';

const SHELL_FONT_PX = 14;
const CWD_STORAGE_KEY = 'sb_agent_shell_cwd';

type Props = {
  active: boolean;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
};

function readStoredCwd(): string {
  if (typeof window === 'undefined') return '';
  try {
    return window.localStorage.getItem(CWD_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

export default function AgentShellPanel({ active, expanded, onExpandedChange }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<'idle' | 'connecting' | 'open' | 'error'>('idle');
  const [statusDetail, setStatusDetail] = useState('');
  const [cwd, setCwd] = useState('');

  const disconnect = useCallback(() => {
    wsRef.current?.close();
    wsRef.current = null;
    termRef.current?.dispose();
    termRef.current = null;
    fitRef.current = null;
    setStatus('idle');
  }, []);

  const fitTerminal = useCallback(() => {
    const fit = fitRef.current;
    const term = termRef.current;
    const ws = wsRef.current;
    if (!fit || !term) return;
    fit.fit();
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: 'resize',
          cols: term.cols,
          rows: term.rows,
        }),
      );
    }
  }, []);

  const connect = useCallback(() => {
    if (!active || !hostRef.current) return;
    disconnect();

    const term = new XTerm({
      fontFamily: 'var(--font-roboto-mono), ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: SHELL_FONT_PX,
      lineHeight: 1.35,
      cursorBlink: true,
      theme: {
        background: '#04070b',
        foreground: '#d9f7ff',
        cursor: '#22d3ee',
        selectionBackground: '#0e7490',
      },
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    const storedCwd = readStoredCwd();
    setCwd(storedCwd);
    setStatus('connecting');
    setStatusDetail('');

    const ws = new WebSocket(resolveAgentShellWsUrl(storedCwd));
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus('open');
      fit.fit();
      ws.send(
        JSON.stringify({
          type: 'resize',
          cols: term.cols,
          rows: term.rows,
        }),
      );
      term.focus();
    };

    ws.onmessage = (event) => {
      if (typeof event.data === 'string') {
        try {
          const payload = JSON.parse(event.data) as { type?: string; message?: string };
          if (payload.type === 'error') {
            setStatus('error');
            setStatusDetail(payload.message || 'Shell unavailable');
            term.writeln(`\r\n\x1b[31m${payload.message || 'Shell unavailable'}\x1b[0m`);
            return;
          }
        } catch {
          term.write(event.data);
          return;
        }
      }
      if (event.data instanceof ArrayBuffer) {
        term.write(new Uint8Array(event.data));
      }
    };

    ws.onerror = () => {
      setStatus('error');
      setStatusDetail('Could not connect to the local agent shell endpoint.');
      term.writeln('\r\n\x1b[31mCould not connect to the local agent shell endpoint.\x1b[0m');
    };

    ws.onclose = () => {
      setStatus((prev) => (prev === 'error' ? prev : 'idle'));
      term.writeln('\r\n\x1b[90m[session closed]\x1b[0m');
    };

    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(new TextEncoder().encode(data));
      }
    });
  }, [active, disconnect]);

  useEffect(() => {
    if (!active) {
      disconnect();
      return;
    }
    connect();
    return () => disconnect();
  }, [active, connect, disconnect]);

  useEffect(() => {
    if (!active) return;
    const timer = window.setTimeout(() => fitTerminal(), expanded ? 220 : 0);
    return () => window.clearTimeout(timer);
  }, [active, expanded, fitTerminal]);

  useEffect(() => {
    if (!active) return;
    const onResize = () => fitTerminal();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [active, fitTerminal]);

  if (!active) {
    return (
      <div className="flex-1 min-h-0 flex flex-col items-center justify-center px-4 py-6 text-center border-l-2 border-cyan-800/20">
        <Terminal size={16} className="text-cyan-400 mb-2" />
        <div className="text-sm font-mono tracking-[0.2em] text-cyan-300">LOCAL SHELL</div>
        <div className="mt-2 text-[13px] font-mono text-[var(--text-secondary)] leading-relaxed">
          Expand Mesh Chat to open your operator shell.
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col border-l-2 border-cyan-800/25 bg-[#04070b]">
      <div className="flex items-center justify-between gap-2 border-b border-cyan-900/40 px-2 py-1.5 shrink-0">
        <div className="min-w-0 text-[12px] font-mono tracking-[0.14em] text-cyan-300/90 truncate">
          {cwd ? cwd : 'operator shell'}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {!expanded ? (
            <button
              type="button"
              onClick={() => onExpandedChange(true)}
              className="px-2 py-0.5 text-[11px] font-mono tracking-[0.12em] text-cyan-300 border border-cyan-800/40 hover:bg-cyan-950/30"
            >
              EXPAND
            </button>
          ) : (
            <button
              type="button"
              onClick={() => onExpandedChange(false)}
              className="px-2 py-0.5 text-[11px] font-mono tracking-[0.12em] text-cyan-300 border border-cyan-800/40 hover:bg-cyan-950/30"
            >
              SNAP
            </button>
          )}
          <button
            type="button"
            onClick={connect}
            className="px-2 py-0.5 text-[11px] font-mono tracking-[0.12em] text-slate-400 border border-slate-700/40 hover:bg-white/5"
          >
            RECONNECT
          </button>
        </div>
      </div>

      {status === 'error' && statusDetail && (
        <div className="px-2 py-1 text-[12px] font-mono text-amber-300/90 border-b border-amber-900/30 bg-amber-950/10 shrink-0">
          {statusDetail}
        </div>
      )}

      <div ref={hostRef} className="flex-1 min-h-[220px] px-1 py-1 overflow-hidden" />

      <div className="border-t border-cyan-900/30 px-2 py-1 text-[11px] font-mono text-slate-500 shrink-0">
        {status === 'connecting'
          ? 'Connecting…'
          : status === 'open'
            ? `${expanded ? 'Expanded' : 'Docked'} · ${SHELL_FONT_PX}px · map stays interactive`
            : 'Local operator shell'}
      </div>
    </div>
  );
}
