window.__ModuleLoader__.load({
  id: '@local/dsh-memory',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useState, useRef } = React;
    const NS = '@local/dsh-memory';
    const PANEL = 'memory';
    const zh = {
      panel: '记忆', title: '工作记忆', intro: '今天你与 AI 的交互，保留真实原文与来源。',
      refresh: '刷新', loading: '正在读取今天的交互…', empty: '今天还没有可显示的交互。',
      emptyHint: '新的轮次出现后，可以在这里按时间查看。', turn: '第 {turn} 轮',
      completed: '已完成', closed_incomplete: '未正常完成', in_progress: '进行中',
      readError: '无法读取工作记忆。', warnings: '部分会话暂时无法读取。', retry: '重试',
      localOnly: '只读视图 · 不生成 AI 摘要',
      open: '查看完整会话', back: '返回', you: '你', assistant: 'AI', tool: '工具',
      tools: '工具调用（{count}）', noContent: '这条消息没有可显示的文本。',
      remember: '记下这一轮', candidateLabel: '这一轮的候选记忆', save: '保存候选',
      cancel: '取消', saved: '已保存为候选', onlyCompleted: '只有已完成轮次可以记下。',
      candidates: '候选记忆（{count}）', localCandidates: '仅保存在这台浏览器，尚未成为正式记忆。',
      compare: '比较', accept: '接受', reject: '拒绝', accepted: '已接受',
      mergeInto: '合并到', newMemory: '自动判断',
      exportJson: '导出', importJson: '导入',
      importFailed: '导入失败：文件格式不正确。', imported: '已导入 {memories} 条正式记忆、{candidates} 条候选。',
      nothingToExport: '还没有可导出的记忆。',
      rejected: '已拒绝', formal: '正式记忆（{count}）', before: '变更前', after: '变更后',
      ADD: '新增', UPDATE: '更新', NO_CHANGE: '无变化', REVIEW: '需要复核', stale: '正式记忆已变化，请重新比较。',
      saveFailed: '操作未完成，请重试。',
      edit: '编辑', saveEdit: '保存修改', history: '历史版本（{count}）', mergedContent: '合并后内容（可编辑）',
      testHost: '测试 Host 连接', pingWaiting: '正在连接 Host…',
      pingOk: 'Host 连接正常（{time}）', pingMissing: 'Host 路由不存在，可能还没重启 DSH。',
      pingForbidden: 'Host 拒绝了请求（跨站或非本机）。', pingFailed: 'Host 无响应（{status}）。',
      pingTimeout: '连接 Host 超时，Host 可能无响应。',
      hostProbing: '记忆库：连接中…', hostConnected: '记忆库：已连接 · {count} 条 · 提交 {head}',
      hostOffline: '记忆库：未连接（本地模式）· {reason}',
      migrateButton: '导入到记忆库（{count} 条）',
      migrateSending: '正在导入记忆库…',
      migrateSummary: '导入完成：新增 {applied} 条，重复 {replayed} 条，失败 {failed} 条，跳过 {skipped} 条（{detail}）',
      migrateNoSkips: '无',
      migrateFailed: '导入失败：{reason}',
    };
    const en = {
      panel: 'Memory', title: 'Working memory', intro: "Today's interactions with your AI, with original text and sources.",
      refresh: 'Refresh', loading: "Reading today's interactions\u2026", empty: 'No interactions to show today.',
      emptyHint: 'New turns will appear here in time order.', turn: 'Turn {turn}',
      completed: 'Completed', closed_incomplete: 'Incomplete', in_progress: 'In progress',
      readError: 'Could not read working memory.', warnings: 'Some Sessions could not be read.', retry: 'Retry',
      localOnly: 'Read-only \u00b7 No AI summaries',
      open: 'Open full conversation', back: 'Back', you: 'You', assistant: 'AI', tool: 'Tool',
      tools: 'Tool activity ({count})', noContent: 'This message has no displayable text.',
      remember: 'Remember this turn', candidateLabel: 'Candidate from this turn', save: 'Save candidate',
      cancel: 'Cancel', saved: 'Saved as a candidate', onlyCompleted: 'Only a completed turn can be remembered.',
      candidates: 'Candidates ({count})', localCandidates: 'Stored only in this browser; not formal memory yet.',
      compare: 'Compare', accept: 'Accept', reject: 'Reject', accepted: 'Accepted',
      mergeInto: 'Merge into', newMemory: 'Automatic',
      exportJson: 'Export', importJson: 'Import',
      importFailed: 'Import failed: the file format is not valid.', imported: 'Imported {memories} formal memories and {candidates} candidates.',
      nothingToExport: 'There is no memory to export yet.',
      rejected: 'Rejected', formal: 'Formal memory ({count})', before: 'Before', after: 'After',
      ADD: 'Add', UPDATE: 'Update', NO_CHANGE: 'No change', REVIEW: 'Needs review', stale: 'Formal memory changed. Compare again.',
      saveFailed: 'The action did not complete. Try again.',
      edit: 'Edit', saveEdit: 'Save changes', history: 'History ({count})', mergedContent: 'Merged content (editable)',
      testHost: 'Test Host connection', pingWaiting: 'Reaching the Host…',
      pingOk: 'Host reached ({time})', pingMissing: 'No Host route; the DSH app may not have restarted yet.',
      pingForbidden: 'The Host refused the request (cross-site or not local).', pingFailed: 'No Host response ({status}).',
      pingTimeout: 'The Host did not answer in time.',
      hostProbing: 'Memory store: connecting…', hostConnected: 'Memory store: connected · {count} entries · commit {head}',
      hostOffline: 'Memory store: not connected (local mode) · {reason}',
      migrateButton: 'Import into the memory store ({count})',
      migrateSending: 'Importing into the memory store…',
      migrateSummary: 'Import finished: {applied} added, {replayed} already present, {failed} failed, {skipped} skipped ({detail})',
      migrateNoSkips: 'none',
      migrateFailed: 'Import failed: {reason}',
    };

    const CANDIDATES_KEY = 'dsh-memory.candidates.v1';
    const FORMAL_KEY = 'dsh-memory.formal.v1';
    const EXPORT_FORMAT = 'dsh-memory/v1';
    // DOCUMENT-RELATIVE on purpose: the Host registers `/api/dsh-memory`, but
    // the page is served with `<base href="./">`, so a leading slash would
    // escape a sub-path deployment. The shipped task board solves it the same
    // way (it drops the leading slash for exactly this reason).
    const HOST_PREFIX = 'api/dsh-memory';
    const dayFormatter = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' });
    const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const dayKey = (milliseconds) => dayFormatter.format(new Date(milliseconds));

    function escapeHtml(value) {
      return value.replace(/[&<>"']/g, (character) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
      })[character]);
    }

    function safeHref(value) {
      try {
        const url = new URL(value);
        return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? escapeHtml(url.href) : null;
      } catch {
        return null;
      }
    }

    function formatInline(value) {
      const placeholders = [];
      const hold = (html) => {
        const token = `\u0000${placeholders.length}\u0000`;
        placeholders.push(html);
        return token;
      };
      let text = escapeHtml(value)
        .replace(/`([^`\n]+)`/g, (_match, code) => hold(`<code>${code}</code>`))
        .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g, (match, label, href) => {
          const safe = safeHref(href);
          return safe ? hold(`<a href="${safe}" target="_blank" rel="noreferrer">${label}</a>`) : match;
        })
        .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
        .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[^*])\*([^*\n]+)\*(?![*])/g, '$1<em>$2</em>');
      return text.replace(/\u0000(\d+)\u0000/g, (_match, index) => placeholders[Number(index)]);
    }

    function formatMessage(value) {
      const lines = String(value).replace(/\r\n/g, '\n').split('\n');
      const html = [];
      let paragraph = [];
      let list = null;
      let quote = [];
      let table = null;
      let code = null;
      const closeParagraph = () => {
        if (paragraph.length === 0) return;
        html.push(`<p>${paragraph.map(formatInline).join('<br>')}</p>`);
        paragraph = [];
      };
      const closeList = () => {
        if (!list) return;
        html.push(`<${list.tag}>${list.items.join('')}</${list.tag}>`);
        list = null;
      };
      const closeQuote = () => {
        if (quote.length === 0) return;
        html.push(`<blockquote>${quote.map(formatInline).join('<br>')}</blockquote>`);
        quote = [];
      };
      const closeTable = () => {
        if (!table) return;
        const [header, ...body] = table;
        html.push(`<table><thead><tr>${header.map((cell) => `<th>${formatInline(cell)}</th>`).join('')}</tr></thead><tbody>${body.map((row) => `<tr>${row.map((cell) => `<td>${formatInline(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
        table = null;
      };
      const closeBlocks = () => {
        closeParagraph();
        closeList();
        closeQuote();
        closeTable();
      };
      for (const line of lines) {
        const fence = line.match(/^```(.*)$/);
        if (fence) {
          if (code) {
            html.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
            code = null;
          } else {
            closeBlocks();
            code = [];
          }
          continue;
        }
        if (code) {
          code.push(line);
          continue;
        }
        if (line.trim() === '') {
          closeBlocks();
          continue;
        }
        const cells = line.trim().startsWith('|') && line.trim().endsWith('|')
          ? line.trim().slice(1, -1).split('|').map((cell) => cell.trim())
          : null;
        if (cells && cells.every((cell) => /^:?-{3,}:?$/.test(cell))) continue;
        if (cells) {
          closeParagraph();
          closeList();
          closeQuote();
          table = table ?? [];
          table.push(cells);
          continue;
        }
        const heading = line.match(/^(#{1,3})\s+(.+)$/);
        if (heading) {
          closeBlocks();
          html.push(`<h${heading[1].length + 2}>${formatInline(heading[2])}</h${heading[1].length + 2}>`);
          continue;
        }
        const quoted = line.match(/^>\s?(.*)$/);
        if (quoted) {
          closeParagraph();
          closeList();
          closeTable();
          quote.push(quoted[1]);
          continue;
        }
        const bullet = line.match(/^[-*]\s+(.+)$/);
        const numbered = line.match(/^\d+[.)]\s+(.+)$/);
        if (bullet || numbered) {
          closeParagraph();
          closeQuote();
          closeTable();
          const tag = bullet ? 'ul' : 'ol';
          if (!list || list.tag !== tag) {
            closeList();
            list = { tag, items: [] };
          }
          list.items.push(`<li>${formatInline((bullet || numbered)[1])}</li>`);
          continue;
        }
        closeList();
        closeQuote();
        closeTable();
        paragraph.push(line);
      }
      if (code) html.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
      closeBlocks();
      return html.join('');
    }

    function FormattedText({ text }) {
      return h('div', { className: 'dm-formatted', dangerouslySetInnerHTML: { __html: formatMessage(text) } });
    }

    function messageText(message) {
      if (!message || !Array.isArray(message.content)) return '';
      return message.content
        .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n')
        .trim();
    }

    function groupTurns(sessionId, events) {
      const turns = [];
      let open;
      for (const event of events) {
        if (!event || typeof event.type !== 'string') continue;
        if (event.type === 'turn/start') {
          if (open) turns.push(open);
          open = {
            session_id: sessionId,
            turn: event.data && event.data.turn,
            start_seq: event.seq,
            end_seq: null,
            started_at: event.time,
            ended_at: null,
            status: 'in_progress',
            events: [],
          };
          continue;
        }
        if (!open) continue;
        open.events.push(event);
        if (event.type === 'turn/end') {
          open.end_seq = event.seq;
          open.ended_at = event.time;
          const kind = event.data && event.data.reason && event.data.reason.kind;
          open.status = kind === 'completed' ? 'completed' : 'closed_incomplete';
          turns.push(open);
          open = undefined;
        }
      }
      if (open) turns.push(open);
      return turns;
    }

    function toolActivity(event) {
      if (!event || !event.data) return null;
      if (event.type === 'tool/call') {
        const name = typeof event.data.name === 'string' && event.data.name !== '' ? event.data.name : 'tool';
        return { id: `tool-call-${event.seq}`, role: 'tool', time: event.time, name, text: '' };
      }
      if (event.type === 'tool/result') {
        const name = event.data.message && typeof event.data.message.name === 'string' ? event.data.message.name : 'tool';
        return {
          id: `tool-result-${event.seq}`, role: 'tool', time: event.time, name, text: messageText(event.data.message),
        };
      }
      return null;
    }

    function conversationMessages(events) {
      const messages = [];
      let tools = [];
      const flushTools = () => {
        if (tools.length === 0) return;
        messages.push({ id: `tools-${tools[0].id}`, role: 'tools', items: tools });
        tools = [];
      };
      for (const event of events) {
        if (!event || !event.data) continue;
        const activity = toolActivity(event);
        if (activity) {
          tools.push(activity);
          continue;
        }
        if (event.type === 'user/message') {
          const source = event.data.source && event.data.source.kind;
          if (source !== 'user') continue;
          const text = messageText(event.data);
          if (text === '') continue;
          flushTools();
          messages.push({ id: `user-${event.seq}`, role: 'you', time: event.time, text });
        } else if (event.type === 'assistant/message') {
          const text = messageText(event.data.message);
          if (text === '') continue;
          flushTools();
          messages.push({ id: `assistant-${event.seq}`, role: 'assistant', time: event.time, text });
        }
      }
      flushTools();
      return messages;
    }

    function userPreview(turn, maxChars = 320) {
      const parts = [];
      const refs = [];
      for (const event of turn.events) {
        if (event.type !== 'user/message') continue;
        if (!event.data || !event.data.source || event.data.source.kind !== 'user') continue;
        const text = messageText(event.data);
        if (text === '') continue;
        parts.push(text);
        refs.push({ session_id: turn.session_id, event_seq: event.seq });
      }
      const full = parts.join('\n');
      return {
        text: full.length > maxChars ? `${full.slice(0, maxChars)}\u2026` : full,
        truncated: full.length > maxChars,
        source_refs: refs,
      };
    }

    function sessionEvents(binding) {
      return binding.eventSource.getSnapshot().entries
        .filter((entry) => entry && entry.type === 'event' && entry.event)
        .map((entry) => entry.event);
    }

    async function loadFullHistory(reference, signal, limit = 40) {
      const session = reference.binding && reference.binding.session;
      if (!session || typeof session.loadOlder !== 'function' || typeof session.getSnapshot !== 'function') return 0;
      let pages = 0;
      while (pages < limit) {
        const snapshot = session.getSnapshot();
        if (!snapshot || snapshot.hasMore !== true) break;
        await session.loadOlder();
        signal.throwIfAborted();
        pages += 1;
      }
      return pages;
    }

    async function readToday(sessions, signal) {
      const today = dayKey(Date.now());
      await sessions.refresh();
      signal.throwIfAborted();
      const listing = sessions.list.getSnapshot();
      const ids = listing.ids.filter((id) => {
        const item = listing.byId[id];
        return item && item.origin !== 'subagent'
          && Number.isFinite(item.updatedAt) && dayKey(item.updatedAt) === today;
      });
      const turns = [];
      const warnings = [];
      for (const sessionId of ids) {
        signal.throwIfAborted();
        const reference = sessions.retain(sessionId, { source: 'memory-view', signal });
        try {
          await reference.ready;
          signal.throwIfAborted();
          await loadFullHistory(reference, signal);
          signal.throwIfAborted();
          const events = sessionEvents(reference.binding);
          const grouped = groupTurns(sessionId, events);
          for (const item of grouped) {
            if (dayKey(item.started_at) !== today) continue;
            const preview = userPreview(item);
            if (preview.text === '') continue;
            turns.push({
              id: `${item.session_id}:${item.turn}`,
              session_id: item.session_id,
              turn: item.turn,
              range: [item.start_seq, item.end_seq],
              started_at: item.started_at,
              status: item.status,
              messages: conversationMessages(item.events),
              ...preview,
            });
          }
        } catch (error) {
          if (signal.aborted) throw error;
          warnings.push({
            session_id: sessionId,
            message: error instanceof Error ? error.message : String(error),
          });
        } finally {
          reference.release();
        }
      }
      turns.sort((left, right) => right.started_at - left.started_at || left.id.localeCompare(right.id));
      return {
        date: today,
        display_date: new Intl.DateTimeFormat(undefined, {
          year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
        }).format(new Date()),
        time_zone: localZone,
        turns,
        warnings,
      };
    }

    function MemoryIcon({ size = 20 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 64 64', fill: 'none', 'aria-hidden': true },
        h('path', { d: 'M18 13h28a7 7 0 0 1 7 7v22a7 7 0 0 1-7 7H34L21 58v-9h-3a7 7 0 0 1-7-7V20a7 7 0 0 1 7-7Z', stroke: 'currentColor', strokeWidth: 3, strokeLinejoin: 'round' }),
        h('path', { d: 'M22 26h20M22 35h12', stroke: 'currentColor', strokeWidth: 3, strokeLinecap: 'round' }),
        h('circle', { cx: 46, cy: 45, r: 10, fill: 'currentColor' }),
        h('path', { d: 'M46 39v6l4 2', stroke: 'var(--dsw-alias-bg-base)', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }));
    }

    function loadStored(key) {
      try {
        const value = JSON.parse(localStorage.getItem(key) || '[]');
        return Array.isArray(value) ? value : [];
      } catch {
        return [];
      }
    }

    function normalize(value) {
      return value.toLocaleLowerCase().replace(/\s+/g, ' ').trim();
    }

    function grams(value) {
      const compact = normalize(value).replace(/\s/g, '');
      const words = normalize(value).split(' ').filter((word) => word.length > 1);
      const pieces = new Set(words);
      for (let index = 0; index < compact.length - 1; index += 1) pieces.add(compact.slice(index, index + 2));
      return pieces;
    }

    function related(left, right) {
      const a = grams(left);
      const b = grams(right);
      let shared = 0;
      for (const piece of a) if (b.has(piece)) shared += 1;
      return shared >= 2;
    }

    function compareCandidate(candidate, memories = loadStored(FORMAL_KEY)) {
      const active = memories.filter((memory) => memory.status === 'active');
      const exact = active.filter((memory) => normalize(memory.content) === normalize(candidate.text));
      if (exact.length === 1) return { outcome: 'NO_CHANGE', memory: exact[0] };
      const matches = active.filter((memory) => related(memory.content, candidate.text));
      if (matches.length > 1 || exact.length > 1) return { outcome: 'REVIEW', matches };
      if (matches.length === 1) return { outcome: 'UPDATE', memory: matches[0], base_version: matches[0].version };
      return { outcome: 'ADD' };
    }

    function reviewView(candidate, memories, targetId) {
      const active = memories.filter((memory) => memory.status === 'active');
      const decision = compareCandidate(candidate, memories);
      const target = targetId ? active.find((memory) => memory.id === targetId) : null;
      const shown = target ? { outcome: 'UPDATE', memory: target } : decision;
      return {
        outcome: shown.outcome,
        before: shown.memory ? shown.memory.content : null,
        after: shown.outcome === 'NO_CHANGE' ? null : candidate.text,
        expectedBaseVersion: target ? target.version : (decision.outcome === 'UPDATE' ? decision.base_version : undefined),
        canAccept: Boolean(target) || (decision.outcome !== 'NO_CHANGE' && decision.outcome !== 'REVIEW'),
      };
    }

    function mergeDraft(original, addition) {
      const base = String(original ?? '').trim();
      const extra = String(addition ?? '').trim();
      if (base === '') return extra;
      if (extra === '') return base;
      if (base.includes(extra)) return base;
      return `${base}\n\n${extra}`;
    }

    function updateMemory(memories, memoryId, baseVersion, content, source) {
      const current = memories.find((memory) => memory.id === memoryId && memory.status === 'active');
      if (!current) throw new Error('missing');
      if (current.version !== baseVersion) throw new Error('stale');
      const newest = memories
        .filter((memory) => memory.id === memoryId)
        .reduce((top, memory) => Math.max(top, memory.version), 0);
      current.status = 'superseded';
      memories.unshift({
        id: memoryId,
        version: newest + 1,
        status: 'active',
        content,
        source: source ?? current.source,
        accepted_at: new Date().toISOString(),
        previous_version: current.version,
      });
      return memories;
    }

    function editMemory(memoryId, content, expectedVersion) {
      const trimmed = String(content ?? '').trim();
      if (trimmed === '') throw new Error('empty');
      const memories = loadStored(FORMAL_KEY);
      updateMemory(memories, memoryId, expectedVersion, trimmed);
      localStorage.setItem(FORMAL_KEY, JSON.stringify(memories));
      return { memories };
    }

    function reviewCandidate(candidateId, action, options = {}) {
      const { targetId, expectedBaseVersion, content } = options;
      const candidates = loadStored(CANDIDATES_KEY);
      const candidate = candidates.find((item) => item.id === candidateId && item.status === 'candidate');
      if (!candidate) throw new Error('missing');
      const memories = loadStored(FORMAL_KEY);
      const automatic = compareCandidate(candidate, memories);
      const selected = targetId ? memories.find((memory) => memory.id === targetId && memory.status === 'active') : null;
      const decision = selected
        ? { outcome: 'UPDATE', memory: selected, base_version: selected.version }
        : automatic;
      const nextContent = typeof content === 'string' && content.trim() !== '' ? content.trim() : candidate.text;
      if (action === 'reject') {
        candidates.splice(candidates.indexOf(candidate), 1);
      } else if (action === 'accept' && decision.outcome === 'ADD') {
        candidates.splice(candidates.indexOf(candidate), 1);
        memories.unshift({
          id: `memory-${candidate.id}`, version: 1, status: 'active', content: nextContent,
          source: candidate.source, accepted_at: new Date().toISOString(),
        });
      } else if (action === 'accept' && decision.outcome === 'UPDATE') {
        const base = expectedBaseVersion === undefined ? decision.base_version : expectedBaseVersion;
        candidates.splice(candidates.indexOf(candidate), 1);
        updateMemory(memories, decision.memory.id, base, nextContent, candidate.source);
      } else {
        throw new Error(decision.outcome);
      }
      localStorage.setItem(CANDIDATES_KEY, JSON.stringify(candidates));
      localStorage.setItem(FORMAL_KEY, JSON.stringify(memories));
      return { candidates, memories };
    }

    function exportMemory() {
      return {
        format: EXPORT_FORMAT,
        exported_at: new Date().toISOString(),
        candidates: loadStored(CANDIDATES_KEY),
        memories: loadStored(FORMAL_KEY),
      };
    }

    function importMemory(value) {
      let data;
      try {
        data = typeof value === 'string' ? JSON.parse(value) : value;
      } catch {
        throw new Error('format');
      }
      if (!data || data.format !== EXPORT_FORMAT || !Array.isArray(data.memories) || !Array.isArray(data.candidates)) {
        throw new Error('format');
      }
      const memories = loadStored(FORMAL_KEY);
      const seen = new Set(memories.map((memory) => `${memory.id}@${memory.version}`));
      let addedMemories = 0;
      for (const memory of data.memories) {
        if (!memory || typeof memory.id !== 'string' || typeof memory.content !== 'string') continue;
        if (!Number.isInteger(memory.version) || memory.version < 1) continue;
        const key = `${memory.id}@${memory.version}`;
        if (seen.has(key)) continue;
        seen.add(key);
        memories.push({
          id: memory.id,
          version: memory.version,
          status: memory.status === 'superseded' ? 'superseded' : 'active',
          content: memory.content,
          source: memory.source,
          accepted_at: memory.accepted_at,
        });
        addedMemories += 1;
      }
      const newest = new Map();
      for (const memory of memories) if (memory.status === 'active') newest.set(memory.id, memory);
      for (const memory of memories) {
        if (memory.status === 'active' && newest.get(memory.id) !== memory) memory.status = 'superseded';
      }
      const candidates = loadStored(CANDIDATES_KEY);
      const known = new Set(candidates.map((candidate) => candidate.id));
      let addedCandidates = 0;
      for (const candidate of data.candidates) {
        if (!candidate || typeof candidate.id !== 'string' || typeof candidate.text !== 'string') continue;
        if (known.has(candidate.id)) continue;
        known.add(candidate.id);
        candidates.push({ ...candidate, status: 'candidate' });
        addedCandidates += 1;
      }
      localStorage.setItem(FORMAL_KEY, JSON.stringify(memories));
      localStorage.setItem(CANDIDATES_KEY, JSON.stringify(candidates));
      return { memories, candidates, added: { memories: addedMemories, candidates: addedCandidates } };
    }

    function loadCandidates() {
      try {
        const value = JSON.parse(localStorage.getItem(CANDIDATES_KEY) || '[]');
        return Array.isArray(value) ? value.filter((item) => item && typeof item.text === 'string') : [];
      } catch {
        return [];
      }
    }

    function saveCandidate(turn, text) {
      if (turn.status !== 'completed') throw new Error('incomplete');
      const trimmed = text.trim();
      if (trimmed === '') throw new Error('empty');
      const candidate = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        text: trimmed,
        status: 'candidate',
        created_at: new Date().toISOString(),
        source: {
          session_id: turn.session_id,
          turn: turn.turn,
          event_seq: turn.source_refs[0] && turn.source_refs[0].event_seq,
        },
      };
      const next = [candidate, ...loadCandidates()].slice(0, 200);
      localStorage.setItem(CANDIDATES_KEY, JSON.stringify(next));
      return next;
    }

    function formatTime(milliseconds, timeZone) {
      return new Intl.DateTimeFormat(undefined, {
        timeZone, hour: '2-digit', minute: '2-digit',
      }).format(new Date(milliseconds));
    }

    function TurnCard({ turn, timeZone, t, onOpen }) {
      const time = formatTime(turn.started_at, timeZone);
      return h('li', { className: 'dm-turn' },
        h('div', { className: 'dm-marker', 'aria-hidden': true }),
        h('button', {
          type: 'button',
          className: 'dm-card',
          'aria-label': t('open'),
          onClick: () => onOpen(turn),
        },
          h('div', { className: 'dm-meta' },
            h('time', { dateTime: new Date(turn.started_at).toISOString() }, time),
            h('span', { className: 'dm-turn-number' }, t('turn').replace('{turn}', turn.turn)),
            h('span', { className: `dm-status dm-status-${turn.status}` }, t(turn.status))),
          h(FormattedText, { text: turn.text }),
          h('span', { className: 'dm-open' }, t('open'))));
    }

    function CandidateForm({ turn, t, onSaved }) {
      const [text, setText] = useState('');
      const [error, setError] = useState('');
      const [open, setOpen] = useState(false);
      if (turn.status !== 'completed') return h('p', { className: 'dm-muted' }, t('onlyCompleted'));
      if (!open) {
        return h('button', {
          type: 'button',
          className: 'dm-remember',
          onClick: () => { setError(''); setOpen(true); },
        }, t('remember'));
      }
      return h('form', {
        className: 'dm-candidate-form',
        onSubmit: (event) => {
          event.preventDefault();
          try {
            onSaved(saveCandidate(turn, text));
            setText('');
            setOpen(false);
          } catch {
            setError(t('onlyCompleted'));
          }
        },
      },
        h('label', null, t('candidateLabel')),
        h('textarea', {
          className: 'dm-textarea',
          value: text, required: true, maxLength: 2000, rows: 4,
          onChange: (event) => setText(event.target.value),
        }),
        h('div', null,
          h('button', { type: 'submit', className: 'dm-refresh' }, t('save')),
          h('button', { type: 'button', className: 'dm-back', onClick: () => setOpen(false) }, t('cancel'))),
        error ? h('p', { className: 'dm-muted', role: 'alert' }, error) : null);
    }

    function ConversationView({ turn, timeZone, t, onBack, onSaved }) {
      return h('section', { className: 'dm-conversation' },
        h('button', { type: 'button', className: 'dm-back', onClick: onBack }, t('back')),
        h('header', { className: 'dm-conversation-header' },
          h('h2', null, t('turn').replace('{turn}', turn.turn)),
          h('span', { className: `dm-status dm-status-${turn.status}` }, t(turn.status)),
          h('code', null, turn.session_id)),
        h('article', { className: 'dm-turn-box' },
          h('div', { className: 'dm-turn-box-header' },
            h('strong', null, t('turn').replace('{turn}', turn.turn)),
            h(CandidateForm, { turn, t, onSaved })),
          h('ol', { className: 'dm-messages' },
          turn.messages.length === 0
            ? h('li', { className: 'dm-muted' }, t('noContent'))
            : turn.messages.map((message) => message.role === 'tools'
              ? h('li', { key: message.id, className: 'dm-tools' },
                h('details', null,
                  h('summary', null, t('tools').replace('{count}', message.items.length)),
                  h('ol', null, message.items.map((item) => h('li', { key: item.id },
                    h('strong', null, item.name),
                    item.text === '' ? null : h(FormattedText, { text: item.text }))))))
              : h('li', {
                key: message.id, className: `dm-message dm-message-${message.role}`,
              },
                h('div', { className: 'dm-message-meta' },
                  h('strong', null, t(message.role)),
                  h('time', { dateTime: new Date(message.time).toISOString() }, formatTime(message.time, timeZone))),
                h(FormattedText, { text: message.text }))))));
    }

    function MemoryCard({ memory, history, t, onSaved }) {
      const [editing, setEditing] = useState(false);
      const [text, setText] = useState('');
      const [error, setError] = useState('');
      return h('article', { className: 'dm-memory-card' },
        h('div', { className: 'dm-memory-card-head' },
          h('span', { className: 'dm-version' }, `v${memory.version}`),
          editing
            ? null
            : h('button', {
              type: 'button',
              className: 'dm-link',
              onClick: () => { setText(memory.content); setError(''); setEditing(true); },
            }, t('edit'))),
        editing
          ? h('form', {
            className: 'dm-memory-edit',
            onSubmit: (event) => {
              event.preventDefault();
              try {
                onSaved(editMemory(memory.id, text, memory.version));
                setEditing(false);
              } catch (thrown) {
                setError(thrown && thrown.message === 'stale' ? t('stale') : t('saveFailed'));
              }
            },
          },
            h('textarea', {
              className: 'dm-textarea',
              value: text,
              rows: 6,
              onChange: (event) => setText(event.target.value),
            }),
            h('div', { className: 'dm-review-actions' },
              h('button', { type: 'submit', className: 'dm-refresh' }, t('saveEdit')),
              h('button', { type: 'button', className: 'dm-back', onClick: () => setEditing(false) }, t('cancel'))),
            error ? h('p', { className: 'dm-muted', role: 'alert' }, error) : null)
          : h(FormattedText, { text: memory.content }),
        history.length > 0
          ? h('details', { className: 'dm-history' },
            h('summary', null, t('history').replace('{count}', history.length)),
            history.map((old) => h('div', { key: old.version, className: 'dm-history-item' },
              h('span', { className: 'dm-version' }, `v${old.version}`),
              h(FormattedText, { text: old.content }))))
          : null);
    }

    function hostError(reason, detail) {
      const error = new Error(reason);
      error.reason = reason;
      if (detail !== undefined) error.detail = detail;
      return error;
    }

    function createHostClient(fetchImpl, base) {
      const root = base || HOST_PREFIX;
      async function readResponse(response) {
        if (response.status === 404) throw hostError('not-mounted');
        if (response.status === 403) throw hostError('forbidden');
        if (response.status === 401) throw hostError('unauthorized');
        let data = null;
        try {
          data = JSON.parse(await response.text());
        } catch {
          data = null;
        }
        if (!response.ok) {
          throw hostError(data && typeof data.error === 'string' ? data.error : `http-${response.status}`);
        }
        if (!data || data.ok !== true) throw hostError('unexpected');
        return data;
      }
      async function get(path) {
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        const timer = controller === null ? null : setTimeout(() => controller.abort(), 5000);
        try {
          const response = await fetchImpl(`${root}${path}`, {
            headers: { accept: 'application/json' },
            signal: controller === null ? undefined : controller.signal,
          });
          return await readResponse(response);
        } finally {
          if (timer !== null) clearTimeout(timer);
        }
      }
      /** POST with JSON. Relative URL, so a sub-path deployment still works. */
      async function post(path, body) {
        const response = await fetchImpl(`${root}${path}`, {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        return readResponse(response);
      }
      return {
        async state() {
          const data = await get('/state');
          return {
            head: typeof data.head === 'string' ? data.head : null,
            memories: Array.isArray(data.memories) ? data.memories : [],
          };
        },
        async ping() {
          return get('/ping');
        },
        /** Move the local store into the ledger. The Host decides what is provable. */
        async migrate(legacy) {
          return post('/migrate', {
            memories: Array.isArray(legacy.memories) ? legacy.memories : [],
            candidates: Array.isArray(legacy.candidates) ? legacy.candidates : [],
          });
        },
      };
    }

    function hostLine(host, t) {
      if (host.status === 'probing') return t('hostProbing');
      if (host.status === 'ok') {
        const head = host.head === null ? '—' : String(host.head).slice(0, 7);
        return t('hostConnected').replace('{count}', String(host.count)).replace('{head}', head);
      }
      return t('hostOffline').replace('{reason}', host.reason || 'unknown');
    }

    /** One sentence about a migration run: what landed, what did not, and why. */
    function migrationSummary(result, t) {
      const applied = Number(result && result.applied) || 0;
      const replayed = Number(result && result.replayed) || 0;
      const failed = Number(result && result.failed) || 0;
      const skipped = Array.isArray(result && result.skipped) ? result.skipped : [];
      const reasons = {};
      for (const entry of skipped) {
        const reason = entry && typeof entry.reason === 'string' ? entry.reason : 'unknown';
        reasons[reason] = (reasons[reason] || 0) + 1;
      }
      const detail = Object.keys(reasons)
        .sort()
        .map((reason) => `${reason} ${reasons[reason]}`)
        .join('，');
      return t('migrateSummary')
        .replace('{applied}', String(applied))
        .replace('{replayed}', String(replayed))
        .replace('{failed}', String(failed))
        .replace('{skipped}', String(skipped.length))
        .replace('{detail}', detail === '' ? t('migrateNoSkips') : detail);
    }

    function MemoryPage({ sessions, t }) {
      const [state, setState] = useState({ status: 'loading', data: null, error: null });
      const [selected, setSelected] = useState(null);
      const [candidates, setCandidates] = useState(loadCandidates);
      const [memories, setMemories] = useState(() => loadStored(FORMAL_KEY));
      const [targets, setTargets] = useState({});
      const [edits, setEdits] = useState({});
      const [notice, setNotice] = useState('');
      const [ping, setPing] = useState('');
      const [host, setHost] = useState({ status: 'probing', count: 0, head: null, reason: '' });
      const probeHost = () => {
        if (typeof fetch !== 'function') {
          setHost({ status: 'offline', count: 0, head: null, reason: 'no-fetch' });
          return;
        }
        setHost({ status: 'probing', count: 0, head: null, reason: '' });
        createHostClient(fetch).state().then((data) => {
          setHost({ status: 'ok', count: data.memories.length, head: data.head, reason: '' });
        }, (error) => {
          setHost({ status: 'offline', count: 0, head: null, reason: (error && error.reason) || 'network' });
        });
      };
      useEffect(() => { probeHost(); }, []);
      const testHost = () => {
        setPing(t('pingWaiting'));
        const failed = (status) => setPing(t('pingFailed').replace('{status}', String(status)));
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        fetch(`${HOST_PREFIX}/ping`, { headers: { accept: 'application/json' }, signal: controller.signal })
          .then((response) => {
            if (response.status === 404) { setPing(t('pingMissing')); return undefined; }
            if (response.status === 403) { setPing(t('pingForbidden')); return undefined; }
            return response.text().then((raw) => {
              let data = null;
              try { data = JSON.parse(raw); } catch { data = null; }
              if (!response.ok || !data || data.ok !== true) { failed(response.status); return; }
              const runtime = data.runtime || {};
              const parts = [];
              if (runtime.node) parts.push(`node ${runtime.node}`);
              if (runtime.electron) parts.push(`electron ${runtime.electron}`);
              if (runtime.sqlite) {
                parts.push(`sqlite ${runtime.sqlite.ok ? (runtime.sqlite.trigram ? 'ok+trigram' : 'ok') : 'no'}`);
              }
              setPing(t('pingOk').replace('{time}', String(data.time)) + (parts.length > 0 ? ` · ${parts.join(' · ')}` : ''));
            }, () => failed(response.status));
          }, (error) => {
            setPing(error && error.name === 'AbortError' ? t('pingTimeout') : failed('network'));
          })
          .then(() => clearTimeout(timer), () => clearTimeout(timer));
      };
      const migrateToHost = () => {
        if (host.status !== 'ok' || typeof fetch !== 'function') return;
        setNotice(t('migrateSending'));
        const client = createHostClient(fetch);
        client.migrate({ memories: loadStored(FORMAL_KEY), candidates: loadStored(CANDIDATES_KEY) }).then((result) => {
          setNotice(migrationSummary(result, t));
          probeHost();
        }, (error) => {
          setNotice(t('migrateFailed').replace('{reason}', (error && error.reason) || 'network'));
        });
      };
      const fileRef = useRef(null);
      const clearDraft = (id) => {
        setTargets((old) => {
          if (!(id in old)) return old;
          const next = { ...old };
          delete next[id];
          return next;
        });
        setEdits((old) => {
          if (!(id in old)) return old;
          const next = { ...old };
          delete next[id];
          return next;
        });
      };
      const applyReview = (id, action, expectedBaseVersion) => {
        try {
          const result = reviewCandidate(id, action, {
            targetId: targets[id] || undefined,
            expectedBaseVersion,
            content: edits[id],
          });
          setCandidates(result.candidates);
          setMemories(result.memories);
          clearDraft(id);
          setNotice('');
        } catch (error) {
          setNotice(error && error.message === 'stale' ? t('stale') : t('saveFailed'));
        }
      };
      const [revision, setRevision] = useState(0);
      useEffect(() => {
        const controller = new AbortController();
        let active = true;
        setState((old) => ({ ...old, status: 'loading', error: null }));
        const service = sessions;
        if (!service) {
          setState({ status: 'error', data: null, error: 'Session service is unavailable' });
          return undefined;
        }
        readToday(service, controller.signal).then((data) => {
          if (active) setState({ status: 'ready', data, error: null });
        }, (error) => {
          if (active && !controller.signal.aborted) {
            setState({ status: 'error', data: null, error: error && error.message ? error.message : String(error) });
          }
        });
        return () => {
          active = false;
          controller.abort();
        };
      }, [revision]);
      const data = state.data;
      if (selected) {
        return h('section', { className: 'dm-page' },
          h(ConversationView, {
            turn: selected, timeZone: data && data.time_zone, t,
            onBack: () => setSelected(null),
            onSaved: (next) => { setCandidates(next); setNotice(t('saved')); },
          }));
      }
      return h('section', { className: 'dm-page', 'aria-busy': state.status === 'loading' },
        h('header', { className: 'dm-header', 'data-window-drag': true },
          h('div', null,
            h('h1', { className: 'dm-title' }, t('title')),
            h('p', { className: 'dm-intro' }, t('intro'))),
          h('div', { className: 'dm-actions' },
            h('button', {
              type: 'button',
              className: 'dm-refresh',
              disabled: memories.length === 0 && candidates.length === 0,
              onClick: () => {
                const blob = new Blob([JSON.stringify(exportMemory(), null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const link = document.createElement('a');
                link.href = url;
                link.download = `dsh-memory-${dayKey(Date.now())}.json`;
                link.click();
                URL.revokeObjectURL(url);
              },
            }, t('exportJson')),
            h('button', {
              type: 'button',
              className: 'dm-refresh',
              onClick: () => { if (fileRef.current) fileRef.current.click(); },
            }, t('importJson')),
            h('input', {
              ref: fileRef,
              type: 'file',
              accept: 'application/json,.json',
              style: { display: 'none' },
              onChange: (event) => {
                const file = event.target.files && event.target.files[0];
                event.target.value = '';
                if (!file) return;
                file.text().then((raw) => {
                  try {
                    const result = importMemory(raw);
                    setMemories(result.memories);
                    setCandidates(result.candidates);
                    setNotice(t('imported').replace('{memories}', result.added.memories).replace('{candidates}', result.added.candidates));
                  } catch {
                    setNotice(t('importFailed'));
                  }
                }, () => setNotice(t('importFailed')));
              },
            }),
            h('button', {
              type: 'button',
              className: 'dm-refresh',
              onClick: testHost,
            }, t('testHost')),
            h('button', {
              type: 'button',
              className: 'dm-refresh',
              disabled: state.status === 'loading',
              onClick: () => setRevision((value) => value + 1),
            }, t(state.status === 'error' ? 'retry' : 'refresh')))),
        h('main', { className: 'dm-content' },
          notice ? h('p', { className: 'dm-muted', role: 'status' }, notice) : null,
          h('p', { className: 'dm-muted', role: 'status' }, hostLine(host, t)),
          host.status === 'ok' && memories.length > 0
            ? h('button', { type: 'button', className: 'dm-refresh', onClick: migrateToHost }, t('migrateButton').replace('{count}', String(memories.length)))
            : null,
          ping ? h('p', { className: 'dm-muted', role: 'status' }, ping) : null,
          state.status === 'error'
            ? h('div', { className: 'dm-notice dm-error', role: 'alert' },
              h('strong', null, t('readError')), h('p', null, state.error))
            : null,
          state.status === 'loading' && !data
            ? h('p', { className: 'dm-muted', role: 'status' }, t('loading'))
            : null,
          data
            ? h(React.Fragment, null,
              memories.filter((memory) => memory.status === 'active').length > 0
                ? h('details', { className: 'dm-memory-bank' },
                  h('summary', null, t('formal').replace('{count}', memories.filter((memory) => memory.status === 'active').length)),
                  memories.filter((memory) => memory.status === 'active').map((memory) => h(MemoryCard, {
                    key: `${memory.id}-${memory.version}`,
                    memory,
                    history: memories
                      .filter((older) => older.id === memory.id && older.status === 'superseded')
                      .sort((left, right) => right.version - left.version),
                    t,
                    onSaved: (result) => { setMemories(result.memories); setNotice(t('saved')); },
                  })))
                : null,
              candidates.filter((candidate) => candidate.status === 'candidate').length > 0
                ? h('details', { className: 'dm-memory-bank' },
                  h('summary', null, t('candidates').replace('{count}', candidates.filter((candidate) => candidate.status === 'candidate').length)),
                  h('p', { className: 'dm-muted' }, t('localCandidates')),
                  candidates.filter((candidate) => candidate.status === 'candidate').map((candidate) => {
                    const active = memories.filter((memory) => memory.status === 'active');
                    const target = targets[candidate.id] || '';
                    const view = reviewView(candidate, memories, target);
                    const draft = edits[candidate.id] === undefined
                      ? (target ? mergeDraft(view.before, candidate.text) : candidate.text)
                      : edits[candidate.id];
                    return h('article', { key: candidate.id, className: 'dm-review-card' },
                      h('div', { className: `dm-outcome dm-outcome-${view.outcome}` }, t(view.outcome)),
                      view.before !== null ? h('section', null, h('h3', null, t('before')), h(FormattedText, { text: view.before })) : null,
                      target
                        ? h('label', { className: 'dm-merge' }, t('mergedContent'),
                          h('textarea', {
                            className: 'dm-textarea',
                            rows: 6,
                            value: draft,
                            onChange: (event) => setEdits((old) => ({ ...old, [candidate.id]: event.target.value })),
                          }))
                        : (view.after !== null ? h('section', null, h('h3', null, t('after')), h(FormattedText, { text: view.after })) : null),
                      h('code', null, `${candidate.source.session_id} · turn ${candidate.source.turn}`),
                      active.length > 0 ? h('label', { className: 'dm-merge' }, t('mergeInto'),
                        h('select', {
                          value: target,
                          onChange: (event) => {
                            setTargets((old) => ({ ...old, [candidate.id]: event.target.value }));
                            setEdits((old) => {
                              if (!(candidate.id in old)) return old;
                              const next = { ...old };
                              delete next[candidate.id];
                              return next;
                            });
                          },
                        },
                          h('option', { value: '' }, t('newMemory')),
                          active.map((memory) => h('option', { key: memory.id, value: memory.id }, memory.content.slice(0, 42))))) : null,
                      h('div', { className: 'dm-review-actions' },
                        h('button', {
                          type: 'button',
                          className: 'dm-refresh',
                          disabled: !view.canAccept,
                          onClick: () => applyReview(candidate.id, 'accept', view.expectedBaseVersion),
                        }, t('accept')),
                        h('button', { type: 'button', className: 'dm-back', onClick: () => applyReview(candidate.id, 'reject') }, t('reject'))));
                  }))
                : null,
              h('div', { className: 'dm-dayline' },
                h('h2', null, data.display_date),
                h('span', { className: 'dm-muted' }, t('localOnly'))),
              data.warnings.length > 0
                ? h('details', { className: 'dm-warning' },
                  h('summary', null, t('warnings')),
                  data.warnings.map((warning) => h('p', { key: warning.session_id }, warning.message)))
                : null,
              data.turns.length === 0
                ? h('div', { className: 'dm-empty' },
                  h(MemoryIcon, { size: 36 }),
                  h('h3', null, t('empty')),
                  h('p', { className: 'dm-muted' }, t('emptyHint')))
                : h('ol', { className: 'dm-timeline', 'aria-label': data.date },
                  data.turns.map((turn) => h(TurnCard, {
                    key: turn.id, turn, timeZone: data.time_zone, t, onOpen: setSelected,
                  }))))
            : null));
    }

    const css = `
      .dm-page{height:100%;display:flex;flex-direction:column;box-sizing:border-box;padding:0 clamp(24px,4vw,48px);color:var(--dsw-alias-label-primary)}
      .dm-header{flex:none;display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:28px 0 24px}
      .dm-title{margin:0;font-size:20px;font-weight:500;line-height:28px}.dm-intro{margin:4px 0 0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
      .dm-refresh{flex:none;border:0.5px solid var(--dsw-alias-border-l3);border-radius:6px;padding:6px 12px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer;font:inherit;font-size:12px}
      .dm-actions{display:flex;align-items:center;gap:8px;flex:none}
      .dm-refresh:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}.dm-refresh:disabled{opacity:.5;cursor:default}
      .dm-refresh:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
      .dm-content{flex:1;min-height:0;overflow-y:auto;padding:0 0 48px}.dm-dayline{display:flex;align-items:baseline;justify-content:space-between;gap:16px;padding-bottom:20px;border-bottom:0.5px solid var(--dsw-alias-border-l3)}
      .dm-dayline h2{margin:0;font-size:15px;font-weight:500}.dm-muted{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}.dm-timeline{list-style:none;margin:0;padding:20px 0 0;position:relative}
      .dm-timeline:before{content:'';position:absolute;top:30px;bottom:30px;left:5px;width:1px;background:var(--dsw-alias-border-l3)}
      .dm-turn{position:relative;padding:0 0 20px 26px}.dm-marker{position:absolute;left:1px;top:22px;width:9px;height:9px;border-radius:50%;background:var(--dsw-alias-state-business-primary);border:2px solid var(--dsw-alias-bg-base)}
      .dm-card{display:block;width:min(760px,100%);border:0.5px solid var(--dsw-alias-border-l3);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:16px 18px;text-align:left;color:inherit;font:inherit;cursor:pointer}
      .dm-card:hover{background:var(--dsw-alias-interactive-bg-hover)}.dm-card:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
      .dm-open{display:block;margin-top:12px;color:var(--dsw-alias-label-tertiary);font-size:12px}
      .dm-conversation{height:100%;display:flex;flex-direction:column;padding:24px 0}.dm-back{align-self:flex-start;border:0;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;font-size:13px;padding:0}
      .dm-conversation-header{display:flex;align-items:center;flex-wrap:wrap;gap:8px 14px;margin:18px 0;padding-bottom:14px;border-bottom:0.5px solid var(--dsw-alias-border-l3)}
      .dm-turn-box{max-width:820px;margin-bottom:18px;padding:14px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}
      .dm-turn-box-header{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}.dm-remember{width:auto;flex:none;border:0.5px solid var(--dsw-alias-border-l3);border-radius:6px;padding:6px 10px;background:var(--dsw-alias-bg-base);color:inherit;font:inherit;font-size:12px;cursor:pointer}
      .dm-conversation-header h2{margin:0;font-size:16px;font-weight:500}.dm-conversation-header code{color:var(--dsw-alias-label-tertiary);font-size:11px;overflow-wrap:anywhere}
      .dm-messages{list-style:none;margin:0;padding:0;overflow-y:auto;display:flex;flex-direction:column;gap:12px}
      .dm-message{max-width:760px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:14px 16px}
      .dm-message-you{border-left:3px solid var(--dsw-alias-state-business-primary)}.dm-message-assistant{border-left:3px solid var(--dsw-alias-state-success-secondary)}.dm-message-tool{border-left:3px solid var(--dsw-alias-state-warn-primary)}
      .dm-message-meta{display:flex;justify-content:space-between;gap:12px;color:var(--dsw-alias-label-tertiary);font-size:12px}
      .dm-formatted{margin-top:10px;overflow-wrap:anywhere;line-height:24px}.dm-formatted>*:first-child{margin-top:0}.dm-formatted>*:last-child{margin-bottom:0}
      .dm-formatted p,.dm-formatted ul,.dm-formatted ol,.dm-formatted blockquote,.dm-formatted table{margin:8px 0}.dm-formatted h3,.dm-formatted h4,.dm-formatted h5{margin:14px 0 6px;line-height:1.4}
      .dm-formatted a{color:var(--dsw-alias-state-business-primary)}.dm-formatted blockquote{padding-left:12px;border-left:3px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary)}
      .dm-formatted table{width:100%;border-collapse:collapse;font-size:13px}.dm-formatted th,.dm-formatted td{padding:6px 8px;border:0.5px solid var(--dsw-alias-border-l3);text-align:left;vertical-align:top}
      .dm-formatted h3{font-size:18px}.dm-formatted h4{font-size:16px}.dm-formatted h5{font-size:14px}.dm-formatted ul,.dm-formatted ol{padding-left:22px}
      .dm-formatted code{padding:1px 4px;border-radius:4px;background:var(--dsw-alias-bg-layer-2);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:.92em}
      .dm-formatted pre{margin:10px 0;padding:12px;overflow-x:auto;border-radius:8px;background:var(--dsw-alias-bg-layer-2)}.dm-formatted pre code{padding:0;background:transparent}
      .dm-tools{max-width:760px;color:var(--dsw-alias-label-tertiary);font-size:12px}.dm-tools summary{cursor:pointer}.dm-tools ol{list-style:none;margin:8px 0 0;padding:0;display:flex;flex-direction:column;gap:8px}
      .dm-tools li{border:0.5px solid var(--dsw-alias-border-l3);border-radius:8px;padding:8px 10px;background:var(--dsw-alias-bg-layer-1)}.dm-tools pre{margin:6px 0 0;white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}
      .dm-meta{display:flex;align-items:center;flex-wrap:wrap;gap:8px 12px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
      .dm-turn-number{font-variant-numeric:tabular-nums}.dm-status{margin-left:auto;font-size:11px}.dm-status-completed{color:var(--dsw-alias-state-success-secondary)}.dm-status-closed_incomplete{color:var(--dsw-alias-state-warn-primary)}
      .dm-preview{margin:12px 0 0;white-space:pre-wrap;overflow-wrap:anywhere;font-size:14px;line-height:23px}.dm-source{margin-top:14px;color:var(--dsw-alias-label-tertiary);font-size:11px;overflow-wrap:anywhere}
      .dm-source summary{cursor:pointer}.dm-source code{display:block;margin-top:8px;font-size:11px}.dm-empty{text-align:center;padding:80px 20px;color:var(--dsw-alias-label-tertiary)}.dm-empty h3{color:var(--dsw-alias-label-primary);font-size:16px;font-weight:500}
      .dm-notice{padding:14px;border-radius:8px;margin-bottom:16px}.dm-error{color:var(--dsw-alias-state-error-primary);border:0.5px solid var(--dsw-alias-border-l3)}
      .dm-warning{margin-bottom:16px;color:var(--dsw-alias-state-warn-primary);font-size:12px}.dm-warning summary{cursor:pointer}
      .dm-candidate-form{display:flex;flex-direction:column;gap:8px;max-width:760px;margin-bottom:18px}.dm-textarea{width:100%;box-sizing:border-box;border:0.5px solid var(--dsw-alias-border-l3);border-radius:8px;padding:10px;background:var(--dsw-alias-bg-base);color:inherit;font:inherit;line-height:22px;resize:vertical}
      .dm-memory-card{display:flex;flex-direction:column;gap:10px}.dm-memory-card-head{display:flex;align-items:center;justify-content:space-between;gap:12px}
      .dm-link{border:0;background:transparent;color:var(--dsw-alias-state-business-primary);cursor:pointer;font:inherit;font-size:12px;padding:0}
      .dm-memory-edit{display:flex;flex-direction:column;gap:8px}
      .dm-history{border-top:0.5px solid var(--dsw-alias-border-l3);padding-top:10px}.dm-history summary{cursor:pointer;color:var(--dsw-alias-label-tertiary);font-size:12px}
      .dm-history-item{margin-top:10px;padding:10px 12px;border-radius:8px;background:var(--dsw-alias-bg-base)}
      .dm-memory-bank{margin-bottom:18px}.dm-memory-bank>summary{width:fit-content;cursor:pointer;font-size:15px;font-weight:500;line-height:24px}.dm-memory-bank>summary:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:3px}
      .dm-memory-bank article{max-width:760px;margin-top:10px;padding:14px 16px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}.dm-version{display:inline-block;margin-bottom:6px;color:var(--dsw-alias-label-tertiary);font-size:11px}
      .dm-review-card{display:flex;flex-direction:column;gap:10px}.dm-outcome{align-self:flex-start;padding:2px 8px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);font-size:12px}
      .dm-review-card h3{margin:0 0 4px;color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:500}.dm-review-card section{padding:10px;border-radius:8px;background:var(--dsw-alias-bg-base)}
      .dm-review-actions{display:flex;gap:12px;align-items:center}.dm-merge{display:flex;flex-direction:column;gap:6px;color:var(--dsw-alias-label-secondary);font-size:12px}.dm-merge select{max-width:420px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:6px;padding:6px 8px;background:var(--dsw-alias-bg-base);color:inherit;font:inherit}
      @media(max-width:600px){.dm-header{flex-wrap:wrap}.dm-status{margin-left:0}.dm-dayline{align-items:flex-start;flex-direction:column;gap:4px}}
    `;

    return {
      inject: ['slots', 'locale'],
      conversationMessages,
      formatMessage,
      saveCandidate,
      compareCandidate,
      reviewCandidate,
      reviewView,
      createHostClient,
      hostLine,
      migrationSummary,
      mergeDraft,
      editMemory,
      loadFullHistory,
      exportMemory,
      importMemory,
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-memory: dictionaries');
        const t = ctx.locale.bind(NS);
        const style = document.createElement('style');
        style.dataset.plugin = '@local/dsh-memory';
        style.textContent = css;
        document.head.append(style);
        ctx.effect(() => () => style.remove(), 'dsh-memory: styles');
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: PANEL, order: 15, label: () => t('panel'), locale: NS,
        }, MemoryIcon));
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main', key: PANEL, locale: NS,
        }, () => h(MemoryPage, { sessions: ctx.get('sessions'), t })));
      },
    };
  },
});
