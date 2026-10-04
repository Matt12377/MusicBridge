import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { IPC_VERSION, type LocalCatalogCommandPayloads, type LocalCatalogInternalCommand } from '@music-bridge/contracts';
import { CoreSupervisor, type CoreMessagePort, type CoreChildProcess } from '../../src/main/core-supervisor.js';
class FakePort implements CoreMessagePort {
  readonly sent: unknown[] = []
  private listener: ((event: { data: unknown }) => void) | undefined
  closed = false

  on(event: 'message', listener: (event: { data: unknown }) => void): void {
    assert.equal(event, 'message')
    this.listener = listener
  }

  start(): void {}

  close(): void {
    this.closed = true
  }

  postMessage(message: unknown): void {
    this.sent.push(message)
  }

  receive(message: unknown): void {
    this.listener?.({ data: message })
  }
}

class FakeChild implements CoreChildProcess {
  readonly posted: unknown[] = []
  private exitListeners: Array<(code: number) => void> = []
  killed = false

  postMessage(message: unknown): void {
    this.posted.push(message)
  }

  once(event: 'exit', listener: (code: number) => void): void {
    assert.equal(event, 'exit')
    this.exitListeners.push(listener)
  }

  kill(): boolean {
    this.killed = true
    this.exit(0)
    return true
  }

  exit(code: number): void {
    const listeners = this.exitListeners.splice(0)
    for (const listener of listeners) listener(code)
  }
}

function makeHarness() {
  const channels: Array<{ port1: FakePort; port2: FakePort }> = []
  const children: FakeChild[] = []
  const forkOptions: Array<{ env: NodeJS.ProcessEnv }> = []
  const dependencies = {
      createChannel: () => {
        const channel = { port1: new FakePort(), port2: new FakePort() }
        channels.push(channel)
        return channel
      },
      fork: (_entryPath: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
        const child = new FakeChild()
        children.push(child)
        forkOptions.push({ env: options.env })
        return child
      },
  }
  const supervisor = new CoreSupervisor({
    entryPath: '/合成/不启动-core-entry.js',
    cwd: '/合成/不启动',
    dependencies,
    requestTimeoutMs: 1_000,
    startupTimeoutMs: 1_000,
  })
  return { channels, children, dependencies, forkOptions, supervisor }
}

function ready(channel: { port2: FakePort }): void {
  channel.port2.receive({
    version: IPC_VERSION,
    event: 'core.ready',
    payload: {
      state: {
        runtime: 'ready',
        roon: 'disconnected',
        provider: 'missing',
        activeStreamCount: 0,
        activePlaybackPresent: false,
      },
    },
  })
}


test('MBRS002 B2 Main：实际普通request零发送拒六可信观察，requestInternal完整scope传私有port', async () => {
  const f = makeHarness(), starting = f.supervisor.start(); ready(f.channels[0]!); await starting;
  const id = randomUUID(), scope = randomUUID();
  const trusted: Pick<LocalCatalogCommandPayloads, LocalCatalogInternalCommand> = {
    'localCatalog.registerRoot':{commandId:id,sourceRootId:id,role:'library'},
    'localCatalog.relinkRoot':{commandId:id,sourceRootId:id,role:'library',rootId:id,expectedRevision:'1'},
    'localCatalog.registerAsset':{commandId:id,libraryRootId:id,expectedRootRevision:'1',relative:'合成.flac',sha256:null,sampleFrames:null,timebaseHz:null},
    'localCatalog.moveAsset':{commandId:id,assetId:id,expectedLocationRevision:'1',expectedRootRevision:'1',relative:'改名.flac'},
    'localCatalog.replaceAsset':{commandId:id,libraryRootId:id,expectedRootRevision:'1',relative:'合成.flac',sha256:null,sampleFrames:null,timebaseHz:null,assetId:id,expectedFileRevision:'1',expectedLocationRevision:'1'},
    'localCatalog.observeMetadata':{commandId:id,trackId:id,source:'synthetic',parserVersion:'fixture-1',fields:{title:'合成'}},
  };
  const port = f.channels[0]!.port2;
  for (const command of Object.keys(trusted) as LocalCatalogInternalCommand[]) {
    const before = port.sent.length;
    await assert.rejects(f.supervisor.request(command,trusted[command],scope),{code:'INVALID_IPC_REQUEST'});
    assert.equal(port.sent.length,before,command);
  }
  await assert.rejects(f.supervisor.request('localCatalog.createEdition',{commandId:id,title:'合成',edition:'',relative:'注入'} as never,scope),{code:'INVALID_IPC_REQUEST'});
  await assert.rejects(f.supervisor.requestInternal('localCatalog.registerRoot',trusted['localCatalog.registerRoot']),{code:'INVALID_IPC_REQUEST'});
  assert.equal(port.sent.length,0);
  const pending = f.supervisor.requestInternal('localCatalog.registerRoot',trusted['localCatalog.registerRoot'],scope);
  await new Promise(resolve => setImmediate(resolve));
  const sent = port.sent[0] as {id:string;command:string;payload:unknown;expectedDatasetId:string};
  assert.equal(sent.command,'localCatalog.registerRoot'); assert.equal(sent.expectedDatasetId,scope); assert.deepEqual(sent.payload,trusted['localCatalog.registerRoot']);
  const root = {id:randomUUID(),sourceRootId:id,role:'library',revision:'1'};
  port.receive({version:1,id:sent.id,ok:true,result:root}); assert.deepEqual(await pending,root);
  // 合成child退出只用于监督器收尾；不启动真实App或账号。
  await f.supervisor.shutdown();
});
