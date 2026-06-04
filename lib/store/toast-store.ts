'use client';

/**
 * Toast store (redesign Phase 5). A tiny zustand store with imperative helpers
 * so non-React code (e.g. the shared `runTx` in usePredictAccount) can fire
 * feedback without prop-drilling. The <Toaster /> subscribes and renders the
 * stack. Success/error/info only — no toast spam, auto-dismissed.
 */
import { create } from 'zustand';

export type ToastKind = 'success' | 'error' | 'info';

export interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  desc?: string;
  href?: string;
  /** ms before auto-dismiss; 0 = sticky */
  ttl: number;
}

interface ToastState {
  toasts: Toast[];
  push: (t: Omit<Toast, 'id'>) => number;
  dismiss: (id: number) => void;
}

let nextId = 1;

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  push: (t) => {
    const id = nextId++;
    set((s) => ({ toasts: [...s.toasts, { ...t, id }] }));
    return id;
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
}));

/** Imperative API — callable anywhere, inside React or not. */
export const toast = {
  success: (title: string, opts?: { desc?: string; href?: string; ttl?: number }) =>
    useToastStore.getState().push({ kind: 'success', title, ttl: 6000, ...opts }),
  error: (title: string, opts?: { desc?: string; href?: string; ttl?: number }) =>
    useToastStore.getState().push({ kind: 'error', title, ttl: 8000, ...opts }),
  info: (title: string, opts?: { desc?: string; href?: string; ttl?: number }) =>
    useToastStore.getState().push({ kind: 'info', title, ttl: 5000, ...opts }),
};
