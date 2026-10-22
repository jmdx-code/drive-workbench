import type { Bridge } from '../core/types';
declare global {
  interface Window {
    workbench: Bridge;
  }
}
export {};
