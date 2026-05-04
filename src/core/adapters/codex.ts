/**
 * Codex CLI Adapter
 *
 * Step 5 起退化为 GenericRuntimeAdapter 的 preset。详见 claude.ts 头注。
 */

import { GenericRuntimeAdapter } from './generic.js';
import { DEFAULT_CONFIG } from '../types.js';

export class CodexAdapter extends GenericRuntimeAdapter {
  constructor() {
    const cfg = DEFAULT_CONFIG.runtimes!.codex;
    super('codex', cfg);
  }
}
