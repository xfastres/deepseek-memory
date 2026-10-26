import { test, after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { GitLedgerAdapter } from '../src/adapter.js';
import { descriptor } from '../src/descriptor.js';
import { OWNER, ref, tempDir } from './helpers.js';

const body = (id) => ({
  id, name: id, description: 'test space', active: true, dbPath: '', createdAt: '2026-10-26T00:00:00Z', updatedAt: '2026-10-26T00:00:00Z',
  provider: { id: 'git-ledger', label: 'Git Ledger', kind: 'local', location: '', apiKeyConfigured: false, settings: {}, configuredSecrets: [], capabilities: descriptor.capabilities },
});

/**
 * Phase-1 evidence hook used by the tests: it stands in for the turn context a
 * later phase will supply. It REFUSES content that came from a memory-plugin
 * message (source.kind !== 'user'), which is the T8 rule.
 */
function evidenceFromTurn(turnMessages) {
  return async (request) => {
    const match = turnMessages.find((m) => m.text.includes(request.content) || request.content.includes(m.text));
    if (match === undefined) return undefined;
    if (match.source.kind !== 'user') return undefined; // injected / plugin / mnemon messages are never user facts
    return { sourceRefs: [{ session_id: match.sessionId, event_seq: match.seq, event_type: 'user/message' }], reason: `用户在事件 #${match.seq} 说出了这条内容。`, actor: 'user' };
  };
}

describe('GitLedgerAdapter', () => {
  let tmp;
  before(async () => { tmp = await tempDir('git-ledger-adapter-'); });
  after(async () => { await tmp.cleanup(); });

  test('remember without evidence returns a truthful candidate receipt and writes nothing', async () => {
    const adapter = new GitLedgerAdapter({ dataDir: join(tmp.dir, 'a'), ownerId: OWNER });
    const receipt = await adapter.remember(body('space-a'), { content: '没有证据的内容', category: 'fact' });
    assert.equal(receipt.action, 'candidate');
    assert.equal(receipt.committed, false);
    const { ledger } = await adapter.space(body('space-a'));
    assert.equal((await ledger.listMemories()).length, 0);
    assert.equal((await adapter.search(body('space-a'), { query: '没有证据' })).results.length, 0);
    await adapter.dispose();
  });

  test('T8 content that only appears in a plugin-injected message is refused; the same content said by the user is accepted', async () => {
    const turn = [
      { sessionId: 'session-x', seq: 10, source: { kind: 'dsh-mnemon', form: 'snapshot' }, text: '用户喜欢深色主题' },
      { sessionId: 'session-x', seq: 12, source: { kind: 'user' }, text: '请记住：我的项目都用 pnpm' },
    ];
    const adapter = new GitLedgerAdapter({ dataDir: join(tmp.dir, 'b'), ownerId: OWNER, evidence: evidenceFromTurn(turn) });
    const injected = await adapter.remember(body('space-b'), { content: '用户喜欢深色主题', category: 'preference', source: 'agent' });
    assert.equal(injected.action, 'candidate');
    assert.equal(injected.committed, false);
    const said = await adapter.remember(body('space-b'), { content: '我的项目都用 pnpm', category: 'preference', source: 'user' });
    assert.equal(said.action, 'stored');
    assert.equal(said.committed, true);
    assert.match(said.commit, /^[0-9a-f]{40}$/u);
    assert.equal(said.indexed, true);
    const found = await adapter.search(body('space-b'), { query: 'pnpm' });
    assert.equal(found.results.length, 1);
    assert.equal(found.results[0].id, said.id);
    assert.equal(found.results[0].externalUri, 'dsh-session://session-x#12');
    assert.equal((await adapter.search(body('space-b'), { query: '深色主题' })).results.length, 0);
    // Same request again: idempotent, reported as skipped with the same id.
    const again = await adapter.remember(body('space-b'), { content: '我的项目都用 pnpm', category: 'preference', source: 'user' });
    assert.equal(again.action, 'skipped');
    assert.equal(again.id, said.id);
    assert.equal(again.commit, said.commit);
    // status / get / list / graph work and declare the right shape.
    const status = await adapter.status(body('space-b'));
    assert.equal(status.healthy, true);
    assert.equal(status.stats.totalInsights, 1);
    assert.equal((await adapter.get(body('space-b'), said.id)).content, '我的项目都用 pnpm');
    assert.equal((await adapter.list(body('space-b'), {})).length, 1);
    assert.equal((await adapter.graph(body('space-b'))).nodes.length, 1);
    assert.equal(adapter.related, undefined, 'related is not faked');
    assert.equal(adapter.forget, undefined, 'forget is not faked');
    assert.equal(adapter.link, undefined, 'link is not faked');
    await adapter.dispose();
  });

  test('registers through the real 0.5.19 provider SDK (mountMemorySpaceProvider) and reopens after dispose', async () => {
    const { mountMemorySpaceProvider, createMemorySpaceProviderFixture } = await import('dsh-mnemon-source-memory-spaces/testing');
    const { default: module, createDefinition, evidenceHooks } = await import('../src/index.js');
    const turn = [{ sessionId: 'session-y', seq: 3, source: { kind: 'user' }, text: '我的时区是 Asia/Shanghai' }];
    evidenceHooks.set('test-turn', evidenceFromTurn(turn));
    // Child config must be JSON-safe (the Source digests it), so the hook is named, not passed.
    const mounted = await mountMemorySpaceProvider(module, { config: { dataDir: join(tmp.dir, 'sdk'), ownerId: OWNER, evidenceHook: 'test-turn' } });
    assert.equal(mounted.registered, true);
    assert.equal(mounted.manifest.apiVersion, 'dsh-mnemon.memory-space-provider/v1');
    assert.equal(mounted.manifest.typeId, 'git-ledger');
    assert.equal(mounted.descriptor.capabilities.forget, false);
    assert.equal(mounted.descriptor.capabilities.deletionMode, 'unsupported');
    const fixture = createMemorySpaceProviderFixture(mounted.descriptor, { ownerId: OWNER }, { dataDir: join(tmp.dir, 'sdk-data'), memoryBodyId: 'space-sdk' });
    const adapter = mounted.createAdapter({ memorySpaces: fixture.authority, memoryBodies: fixture.authority, config: { timeoutMs: 10000, defaultRecallLimit: 5 } });
    assert.equal(adapter.id, 'git-ledger');
    const receipt = await adapter.remember(fixture.body, { content: '我的时区是 Asia/Shanghai', category: 'fact', source: 'user' });
    assert.equal(receipt.action, 'stored');
    assert.equal((await adapter.search(fixture.body, { query: 'Asia/Shanghai' })).results.length, 1);
    await mounted.dispose();
    // Reopen with a brand-new adapter over the same directory: the memory is still there (restart).
    const reopened = createDefinition({ dataDir: join(tmp.dir, 'sdk'), ownerId: OWNER }).create({ memorySpaces: fixture.authority, memoryBodies: fixture.authority, config: { timeoutMs: 10000 }, providerInstanceId: 'x', manifest: mounted.manifest });
    assert.equal((await reopened.search(fixture.body, { query: 'Asia/Shanghai' })).results.length, 1);
    await reopened.dispose();
  });
});
