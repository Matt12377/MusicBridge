import { randomUUID } from 'node:crypto';
import { MessagePort } from 'node:worker_threads';
import { relocationFail } from './local-relocation-journal.js';

export interface RelocationMainActor { readonly authorityId: string; readonly active: boolean }
const actors = new WeakSet<object>();
/** 仅已交付的本域实际Node端口产生actor；JSON、旧012端口actor和结构相似对象都不能造能力。 */
export function createRelocationMainActor(port: MessagePort): RelocationMainActor {
  if (!(port instanceof MessagePort)) return relocationFail('GRANT_INVALID');
  let active = true;
  const actor = Object.freeze({ authorityId: randomUUID(), get active() { return active; } });
  actors.add(actor);
  port.once('close', () => { active = false; }); port.once('messageerror', () => { active = false; });
  return actor;
}
export function assertRelocationMainActor(actor: unknown): asserts actor is RelocationMainActor {
  if (!actor || typeof actor !== 'object' || !actors.has(actor) || !(actor as RelocationMainActor).active) relocationFail('GRANT_INVALID');
}
