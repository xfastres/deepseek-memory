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
      candidates: '候选记忆（{count}）', localCandidates: '本地存储 · 未进 Git 账本；Host 在线时可用上方「导入到记忆库」送入运行时队列。',
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
      migrateButton: '导入到记忆库（{count} 项）',
      migrateSending: '正在导入记忆库…',
      migrateSummary: '导入完成：新增 {applied} 条，重复 {replayed} 条，失败 {failed} 条，跳过 {skipped} 条（{detail}）',
      migrateNoSkips: '无',
      migrateFailed: '导入失败：{reason}',
      ledgerTitle: '记忆库内容（{count} 条）',
      ledgerActive: '已生效',
      ledgerInactive: '已撤回',
      candidateEmpty: '候选内容不能为空。',
      emptyContent: '内容不能为空。',
      evidence: '原始证据', viewEvidence: '查看原始证据', evidenceLoading: '正在读取原始证据…',
      evidenceMissing: '这条记忆没有可用的原始证据引用。',
      evidenceUnavailable: '无法定位原始证据：该会话可能已不可用。',
      evidenceOutside: '该事件不在可读取的会话历史中。',
      evidenceLocated: '已定位到产生这条记忆的用户消息（高亮显示）。',
      retract: '撤回', confirmRetract: '确认撤回', retracted: '已撤回，历史版本仍保留。',
      retractFailed: '撤回未完成：{reason}', versionChanged: '账本已变化，请刷新后重试。',
      hostBusy: '账本正在写入，请稍后重试。', missingMemory: '这条记忆在账本中已不存在。',
      hostCandidates: 'Host 候选队列（{count}）',
      history: '历史', historyLoading: '正在读取版本历史…', historyError: '无法读取版本历史。',
      origin: '来源', originRule: '自动提取', originUser: '用户手动', originLegacy: '旧数据迁移', originLlm: '模型建议',
      sourceKindUserExplicit: '用户明确', sourceKindUserCorrection: '用户纠正', sourceKindSessionExtraction: '会话提取', sourceKindAgentInference: '模型推断',
      decisionNew: '新增', decisionDuplicate: '与现有记忆相同', decisionConflict: '需与现有记忆合并', decisionTarget: '参照 {id}',
      object: '标记有误', objectConfirm: '确认标记有误', objected: '已抑制', reviewPendingBadge: '待核查', reinstate: '恢复使用', acceptAsIs: '接受现状', objectKind: '问题类型',
      candidateProposed: '已提出', candidateValidating: '校验中', candidateReviewPending: '待复核', candidateAutoAccepted: '自动接受',
      proposalsTitle: 'AI 提案（{count}）', proposalsHint: '来自模型的修改建议：接受才会写入账本，且按你看到的版本校验。',
      proposalsEmpty: '没有待处理的提案。', proposalAccept: '接受提案', proposalReject: '拒绝提案',
      proposalAdd: '新增', proposalUpdate: '修改', proposalMerge: '合并', proposalRetract: '撤回',
      proposalStale: '账本已变化，请刷新后再决定。', proposalMissingTarget: '目标记忆已不在账本中。',
      proposalAccepted: '提案已接受，写入已通过账本。', proposalRejected: '提案已拒绝。', proposalFailed: '提案操作未完成：{reason}',
      proposalBefore: '当前版本', proposalAfter: '提案内容',
      candidateAcceptedByUser: '用户接受', candidateRejected: '已拒绝', candidateConflict: '冲突', candidateNoChange: '无需变化', candidateFailed: '失败',
      settingsTitle: '自动记忆设置', settingsOn: '允许自动提取候选（总开关）', settingsAutoAccept: '允许低风险候选自动写入（默认关闭）',
      settingsSave: '保存设置', settingsSaved: '设置已保存。', settingsFailed: '设置保存失败，请重试。', settingsHint: '自动接受只影响证据充分、无冲突、非敏感的事实/偏好/约束；随时可关闭。',
      kindWrong: '错误', kindTooBroad: '太宽泛', kindOutdated: '过期', kindMissingContext: '缺少上下文',
      kindWrongScope: '范围错误', kindDuplicate: '重复', kindShouldNotSave: '不应保存', kindDelete: '删除',
      objectedDone: '已标记有误：这条记忆会立即退出检索与注入，账本内容不变。', objectFailed: '标记失败，请重试。', reinstateDone: '已恢复使用。',
      policy: '策略', policyAutoAccept: '可自动接受', policyAutoAcceptOff: '可自动接受（自动接受已关闭）', policyReview: '待复核', policyConflict: '冲突待处理', policyNoChange: '无需变化', policyReject: '拒绝写入',
      recentChanges: '最近变更 · Git 留痕（{count} 条）', recentChangesEmpty: '账本还没有提交记录。',
      recentChangesError: '无法读取账本变更记录。', ledgerHead: '账本 HEAD：{head}', changeStatus: '{before} → {after}',
      historyEmpty: '没有可显示的版本。', historyVersion: '版本 {version}',
      hostCandidateAccepted: '已接受候选，记忆已写入账本。', hostCandidateRejected: '已拒绝该候选。', hostCandidateFailed: '候选操作未完成：{reason}', hostCandidatesHint: '来自运行时数据库：接受经 Host Writer 写入 Git 账本，拒绝只改变运行时候选状态。',
      hostCandidatesEmpty: 'Host 队列里还没有候选。', hostCandidatesError: '无法读取 Host 候选队列（Host 离线或运行时不可用）。',
      search: '搜索记忆…', filterType: '类型', filterStatus: '状态', filterAll: '全部',
      filterEmpty: '没有匹配这些筛选条件的记忆。', searchClear: '清除搜索',
      traceTitle: '注入追踪（{count}）', traceHint: '只读审计 · 不包含记忆正文 · 展开时才读取',
      traceEmpty: '还没有注入记录。', traceError: '无法读取注入记录。', traceLoading: '正在读取注入记录…',
      traceStateReturned: '宿主已返回注入文本', traceConfirmed: '已确认模型使用',
      traceUnconfirmed: '尚未确认模型是否使用', notProvided: '该记录未提供',
      traceTurn: '轮次', traceChars: '字符', traceCalls: '调用',
      traceSnapshot: '审计快照', traceReasons: '选择原因', tracePools: '预算',
      traceMemories: '入选记忆', traceExcluded: '排除', traceConstraint: '约束', traceDynamic: '动态',
      kindConstraint: '约束记忆', kindDynamic: '动态记忆',
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
      candidates: 'Candidates ({count})', localCandidates: 'Local storage · not in the Git ledger; with the Host online, use "Import into the memory store" above to move it into the runtime queue.',
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
      migrateButton: 'Import into the memory store ({count} items)',
      migrateSending: 'Importing into the memory store…',
      migrateSummary: 'Import finished: {applied} added, {replayed} already present, {failed} failed, {skipped} skipped ({detail})',
      migrateNoSkips: 'none',
      migrateFailed: 'Import failed: {reason}',
      ledgerTitle: 'Memory store contents ({count})',
      ledgerActive: 'active',
      ledgerInactive: 'retracted',
      candidateEmpty: 'The candidate text is empty.',
      emptyContent: 'Content cannot be empty.',
      evidence: 'Evidence', viewEvidence: 'View evidence', evidenceLoading: 'Reading the original evidence…',
      evidenceMissing: 'This memory carries no evidence reference.',
      evidenceUnavailable: 'Could not locate the evidence: that Session may be unavailable.',
      evidenceOutside: 'That event is not inside the readable Session history.',
      evidenceLocated: 'Located the user message that produced this memory (highlighted).',
      retract: 'Retract', confirmRetract: 'Confirm retraction', retracted: 'Retracted; history is still kept.',
      retractFailed: 'Retraction failed: {reason}', versionChanged: 'The ledger changed; refresh and retry.',
      hostBusy: 'The ledger is writing; retry in a moment.', missingMemory: 'This memory no longer exists in the ledger.',
      hostCandidates: 'Host candidate queue ({count})',
      history: 'History', historyLoading: 'Reading version history…', historyError: 'Could not read the version history.',
      origin: 'Origin', originRule: 'auto-extracted', originUser: 'added by user', originLegacy: 'legacy import', originLlm: 'model suggestion',
      sourceKindUserExplicit: 'stated by user', sourceKindUserCorrection: 'user correction', sourceKindSessionExtraction: 'session extraction', sourceKindAgentInference: 'agent inference',
      decisionNew: 'new', decisionDuplicate: 'same as an existing memory', decisionConflict: 'needs merging with an existing memory', decisionTarget: 'refers to {id}',
      object: 'mark wrong', objectConfirm: 'confirm: mark wrong', objected: 'suppressed', reviewPendingBadge: 'needs review', acceptAsIs: 'keep as is',
      reinstate: 'restore', objectKind: 'problem',
      candidateProposed: 'proposed', candidateValidating: 'validating', candidateReviewPending: 'needs review', candidateAutoAccepted: 'auto-accepted',
      proposalsTitle: 'AI proposals ({count})', proposalsHint: 'Suggestions from the model: nothing is written until you accept, checked against the version you see.',
      proposalsEmpty: 'No open proposals.', proposalAccept: 'Accept proposal', proposalReject: 'Reject proposal',
      proposalAdd: 'add', proposalUpdate: 'update', proposalMerge: 'merge', proposalRetract: 'retract',
      proposalStale: 'The ledger changed; refresh before deciding.', proposalMissingTarget: 'The target memory is no longer in the ledger.',
      proposalAccepted: 'Proposal accepted and written through the ledger.', proposalRejected: 'Proposal rejected.', proposalFailed: 'The proposal action did not finish: {reason}',
      proposalBefore: 'Current version', proposalAfter: 'Proposed text',
      candidateAcceptedByUser: 'accepted by the user', candidateRejected: 'rejected', candidateConflict: 'conflict', candidateNoChange: 'no change needed', candidateFailed: 'failed',
      settingsTitle: 'Automatic memory', settingsOn: 'queue extracted candidates (master switch)', settingsAutoAccept: 'write low-risk candidates without review (off by default)',
      settingsSave: 'Save settings', settingsSaved: 'Settings saved.', settingsFailed: 'Could not save the settings. Try again.', settingsHint: 'Auto-accept only covers evidenced, non-conflicting, non-sensitive facts, preferences and constraints. It can be switched off at any time.',
      kindWrong: 'wrong', kindTooBroad: 'too broad', kindOutdated: 'outdated', kindMissingContext: 'missing context',
      kindWrongScope: 'wrong scope', kindDuplicate: 'duplicate', kindShouldNotSave: 'should not be saved', kindDelete: 'delete',
      objectedDone: 'Marked wrong: this memory leaves retrieval and injection now; the ledger is unchanged.', objectFailed: 'Could not record the objection. Try again.', reinstateDone: 'Restored.',
      policy: 'Policy', policyAutoAccept: 'eligible for auto-accept', policyAutoAcceptOff: 'eligible, auto-accept off', policyReview: 'needs review', policyConflict: 'conflict to resolve', policyNoChange: 'no change needed', policyReject: 'rejected by policy',
      recentChanges: 'Recent changes · Git trail ({count})', recentChangesEmpty: 'The ledger has no commits yet.',
      recentChangesError: 'Could not read the ledger change trail.', ledgerHead: 'Ledger HEAD: {head}', changeStatus: '{before} → {after}',
      historyEmpty: 'No versions to show.', historyVersion: 'Version {version}',
      hostCandidateAccepted: 'Candidate accepted; the memory is now in the ledger.', hostCandidateRejected: 'Candidate rejected.', hostCandidateFailed: 'Candidate action failed: {reason}', hostCandidatesHint: 'From the runtime database: accept writes the Git ledger via the Host Writer, reject only changes the runtime status.',
      hostCandidatesEmpty: 'The Host queue has no candidates yet.', hostCandidatesError: 'Could not read the Host candidate queue (Host offline or runtime unavailable).',
      search: 'Search memories…', filterType: 'Type', filterStatus: 'Status', filterAll: 'All',
      filterEmpty: 'No memories match these filters.', searchClear: 'Clear search',
      traceTitle: 'Injection trace ({count})', traceHint: 'Read-only audit · no memory bodies · loaded on expand',
      traceEmpty: 'No injection records yet.', traceError: 'Could not read injection records.', traceLoading: 'Reading injection records…',
      traceStateReturned: 'Host returned injected text', traceConfirmed: 'Model use confirmed',
      traceUnconfirmed: 'Model use not confirmed yet', notProvided: 'Not provided by this record',
      traceTurn: 'Turn', traceChars: 'chars', traceCalls: 'calls',
      traceSnapshot: 'Snapshot head', traceReasons: 'Why chosen', tracePools: 'Budget',
      traceMemories: 'Chosen', traceExcluded: 'Excluded', traceConstraint: 'Constraint', traceDynamic: 'Dynamic',
      kindConstraint: 'Constraint memory', kindDynamic: 'Dynamic memory',
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
          messages.push({ id: `user-${event.seq}`, role: 'you', time: event.time, text, seq: event.seq });
        } else if (event.type === 'assistant/message') {
          const text = messageText(event.data.message);
          if (text === '') continue;
          flushTools();
          messages.push({ id: `assistant-${event.seq}`, role: 'assistant', time: event.time, text, seq: event.seq });
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

    /** Evidence pointers the record actually carries; an empty list is a real answer. */
    function evidenceRefsOf(memory) {
      const refs = [];
      const push = (value) => {
        if (!value || typeof value !== 'object') return;
        const sessionId = typeof value.session_id === 'string' ? value.session_id : '';
        const eventSeq = Number.isInteger(value.event_seq) ? value.event_seq : null;
        if (sessionId === '' || eventSeq === null) return;
        if (refs.some((ref) => ref.session_id === sessionId && ref.event_seq === eventSeq)) return;
        refs.push({ session_id: sessionId, event_seq: eventSeq });
      };
      for (const ref of Array.isArray(memory && memory.source_refs) ? memory.source_refs : []) push(ref);
      if (memory) push(memory.source);
      return refs;
    }

    /** The turn that owns an event seq, or null when the seq is outside the read window. */
    function locateTurnForEvent(turns, ref) {
      if (!Array.isArray(turns) || !ref) return null;
      return turns.find((turn) => turn && turn.session_id === ref.session_id
        && Array.isArray(turn.range) && turn.range[0] <= ref.event_seq && ref.event_seq <= turn.range[1]) ?? null;
    }

    /** Build the same turn shape the today timeline uses, from grouped session events. */
    function evidenceTurn(sessionId, item) {
      const preview = userPreview(item);
      return {
        id: sessionId + ':' + item.turn,
        session_id: sessionId,
        turn: item.turn,
        range: [item.start_seq, item.end_seq],
        started_at: item.started_at,
        status: item.status,
        messages: conversationMessages(item.events),
        ...preview,
      };
    }

    /** One evidence action per ledger row, or nothing when the row carries no pointer. */
    function ledgerEvidenceButton(row, t, onEvidence) {
      return Array.isArray(row && row.refs) && row.refs.length > 0
        ? h('button', { type: 'button', className: 'dm-link', onClick: () => onEvidence({ source_refs: row.refs }) }, t('viewEvidence'))
        : null;
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

    /** Mark only the message whose event seq produced the memory. */
    function messageClass(message, highlightSeq) {
      const base = 'dm-message dm-message-' + (message && typeof message.role === 'string' ? message.role : 'assistant');
      if (!Number.isInteger(highlightSeq) || !message || message.seq !== highlightSeq) return base;
      return base + ' dm-message-hit';
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

    /** Which message a failed candidate save deserves. */
    function candidateErrorKey(thrown) {
      return thrown && thrown.message === 'empty' ? 'candidateEmpty' : 'onlyCompleted';
    }

    /** Blank candidates cannot be saved, so the submit action is disabled early. */
    function candidateSubmitDisabled(text) {
      return String(text ?? '').trim() === '';
    }

    /** The memory editor saves one text field too, so it shares the same guard. */
    const textSubmitDisabled = candidateSubmitDisabled;

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
          } catch (thrown) {
            setError(t(candidateErrorKey(thrown)));
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
          h('button', { type: 'submit', className: 'dm-refresh', disabled: candidateSubmitDisabled(text) }, t('save')),
          h('button', { type: 'button', className: 'dm-back', onClick: () => setOpen(false) }, t('cancel'))),
        error ? h('p', { className: 'dm-muted', role: 'alert' }, error) : null);
    }

    function ConversationView({ turn, timeZone, t, onBack, onSaved, highlightSeq }) {
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
          Number.isInteger(highlightSeq)
            ? h('p', { className: 'dm-muted dm-evidence-located' }, t('evidenceLocated'))
            : null,
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
                key: message.id, className: messageClass(message, highlightSeq),
              },
                h('div', { className: 'dm-message-meta' },
                  h('strong', null, t(message.role)),
                  h('time', { dateTime: new Date(message.time).toISOString() }, formatTime(message.time, timeZone))),
                h(FormattedText, { text: message.text }))))));
    }

    function MemoryCard({ memory, history, t, onSaved, onEvidence }) {
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
                const reason = thrown && thrown.message;
                setError(reason === 'stale' ? t('stale') : reason === 'empty' ? t('emptyContent') : t('saveFailed'));
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
              h('button', { type: 'submit', className: 'dm-refresh', disabled: textSubmitDisabled(text) }, t('saveEdit')),
              h('button', { type: 'button', className: 'dm-back', onClick: () => setEditing(false) }, t('cancel'))),
            error ? h('p', { className: 'dm-muted', role: 'alert' }, error) : null)
          : h(FormattedText, { text: memory.content }),
        evidenceRefsOf(memory).length > 0 && typeof onEvidence === 'function'
          ? h('div', { className: 'dm-evidence' }, h('button', { type: 'button', className: 'dm-link', onClick: () => onEvidence(memory) }, t('viewEvidence')))
          : null,
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
        /** Change one ledger memory through the single writer; the base change id detects stale edits. */
        async update({ memoryId, content, expectedBaseChangeId, clearObjection }) {
          const body = { memoryId, content };
          if (clearObjection === true) body.clearObjection = true;
          if (typeof expectedBaseChangeId === 'string' && expectedBaseChangeId !== '') body.expectedBaseChangeId = expectedBaseChangeId;
          return post('/update', body);
        },
        /** Retract instead of deleting: the ledger keeps the history. */
        async retract({ memoryId, expectedBaseChangeId, reason }) {
          const body = { memoryId };
          if (typeof expectedBaseChangeId === 'string' && expectedBaseChangeId !== '') body.expectedBaseChangeId = expectedBaseChangeId;
          if (typeof reason === 'string' && reason !== '') body.reason = reason;
          return post('/retract', body);
        },
        /** Read the runtime candidate queue; this never mutates anything. */
        async candidates() {
          const data = await get('/candidates');
          return {
            candidates: Array.isArray(data.candidates) ? data.candidates : [],
            summary: data.summary && typeof data.summary === 'object' ? data.summary : null,
          };
        },
        /** Queue a candidate. Evidence resolution stays on the Host. */
        async candidate(payload) {
          return post('/candidate', payload);
        },
        /** Reject, accept or merge a Host candidate through the single writer. */
        async review(payload) {
          return post('/review', payload);
        },
        /** Version timeline of one memory. Read-only, like /state. */
        /** AI proposals (§11). Listing is read-only; deciding is not. */
        async proposals() {
          return get('/proposals');
        },
        /** Accept or reject one proposal. The user's action, never the model's. */
        async reviewProposal({ proposalId, action, expectedBaseChangeId }) {
          const body = { proposalId, action };
          if (typeof expectedBaseChangeId === 'string' && expectedBaseChangeId !== '') body.expectedBaseChangeId = expectedBaseChangeId;
          return post('/proposals', body);
        },
        /** The automatic-memory switches, as the Host has them. */
        async settings() {
          return get('/settings');
        },
        /** Change only the switches named here; the Host owns the rest. */
        async saveSettings({ enabled, autoAccept, autoAcceptTypes }) {
          const body = {};
          if (typeof enabled === 'boolean') body.enabled = enabled;
          if (typeof autoAccept === 'boolean') body.autoAccept = autoAccept;
          if (Array.isArray(autoAcceptTypes)) body.autoAcceptTypes = autoAcceptTypes;
          return post('/settings', body);
        },
        /** The runtime objections, and which memory ids they currently suppress. */
        async objections() {
          return get('/objections');
        },
        /** Call a memory wrong: runtime suppression only, never a ledger write. */
        async object({ memoryId, kind, reason }) {
          const body = { memoryId };
          if (typeof kind === 'string' && kind !== '') body.kind = kind;
          if (typeof reason === 'string' && reason !== '') body.reason = reason;
          return post('/objections', body);
        },
        /** Undo the objection for one memory. */
        async clearObjection({ memoryId }) {
          return post('/objections/clear', { memoryId });
        },
        async history({ memoryId }) {
          return get(`/history?memoryId=${encodeURIComponent(String(memoryId ?? ''))}`);
        },
        /** Recent ledger commits across memories. Read-only, like /state. */
        async changes({ limit } = {}) {
          const suffix = Number.isInteger(limit) && limit > 0 ? `?limit=${limit}` : '';
          return get(`/changes${suffix}`);
        },
      };
    }

    /**
     * Line diff via LCS. Every emitted line is honestly unchanged, removed or
     * added; very large inputs fall back to a coarse but still truthful split.
     */
    function diffLines(before, after) {
      const split = (value) => {
        const text = String(value ?? '');
        return text === '' ? [] : text.split('\n');
      };
      const a = split(before);
      const b = split(after);
      if (a.length > 400 || b.length > 400) {
        const out = [];
        const common = Math.min(a.length, b.length);
        let same = 0;
        while (same < common && a[same] === b[same]) same += 1;
        for (let index = 0; index < same; index += 1) out.push({ kind: 'same', text: a[index] });
        for (let index = same; index < a.length; index += 1) out.push({ kind: 'del', text: a[index] });
        for (let index = same; index < b.length; index += 1) out.push({ kind: 'add', text: b[index] });
        return out;
      }
      const table = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
      for (let i = a.length - 1; i >= 0; i -= 1) {
        for (let j = b.length - 1; j >= 0; j -= 1) {
          table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
        }
      }
      const out = [];
      let i = 0;
      let j = 0;
      while (i < a.length && j < b.length) {
        if (a[i] === b[j]) { out.push({ kind: 'same', text: a[i] }); i += 1; j += 1; }
        else if (table[i + 1][j] >= table[i][j + 1]) { out.push({ kind: 'del', text: a[i] }); i += 1; }
        else { out.push({ kind: 'add', text: b[j] }); j += 1; }
      }
      while (i < a.length) { out.push({ kind: 'del', text: a[i] }); i += 1; }
      while (j < b.length) { out.push({ kind: 'add', text: b[j] }); j += 1; }
      return out;
    }

    /** A candidate status in words; an unknown status is shown verbatim. */
    function candidateStatusLabel(status, t) {
      if (status === 'proposed') return t('candidateProposed');
      if (status === 'validating') return t('candidateValidating');
      if (status === 'review_pending') return t('candidateReviewPending');
      if (status === 'auto_accepted') return t('candidateAutoAccepted');
      if (status === 'accepted_by_user') return t('candidateAcceptedByUser');
      if (status === 'rejected') return t('candidateRejected');
      if (status === 'conflict') return t('candidateConflict');
      if (status === 'no_change') return t('candidateNoChange');
      if (status === 'failed') return t('candidateFailed');
      return null;
    }

    /** A correction kind in words; unknown or absent stays silent. */
    function correctionLabel(kind, t) {
      if (kind === 'wrong') return t('kindWrong');
      if (kind === 'too_broad') return t('kindTooBroad');
      if (kind === 'outdated') return t('kindOutdated');
      if (kind === 'missing_context') return t('kindMissingContext');
      if (kind === 'wrong_scope') return t('kindWrongScope');
      if (kind === 'duplicate') return t('kindDuplicate');
      if (kind === 'should_not_save') return t('kindShouldNotSave');
      if (kind === 'delete') return t('kindDelete');
      return null;
    }

    /** The policy decision in words; unknown or absent stays silent. */
    function policyLabel(policy, t) {
      const decision = policy !== null && typeof policy === 'object' && typeof policy.decision === 'string' ? policy.decision : (typeof policy === 'string' ? policy : null);
      const reasons = policy !== null && typeof policy === 'object' && Array.isArray(policy.reasons) ? policy.reasons : [];
      if (decision === 'AUTO_ACCEPT') return t('policyAutoAccept');
      if (decision === 'REVIEW_REQUIRED') return reasons.includes('auto-accept-disabled') ? t('policyAutoAcceptOff') : t('policyReview');
      if (decision === 'CONFLICT') return t('policyConflict');
      if (decision === 'NO_CHANGE') return t('policyNoChange');
      if (decision === 'REJECT') return t('policyReject');
      return null;
    }

    /** The classifier's answer in words; unknown or absent stays silent. */
    function decisionLabel(decision, t) {
      if (decision === 'ADD') return t('decisionNew');
      if (decision === 'NO_CHANGE') return t('decisionDuplicate');
      if (decision === 'CONFLICT') return t('decisionConflict');
      return null;
    }

    /** How a formal memory came to be, in words; unknown or absent stays silent. */
    function sourceKindLabel(kind, t) {
      if (kind === 'user-explicit') return t('sourceKindUserExplicit');
      if (kind === 'user-correction') return t('sourceKindUserCorrection');
      if (kind === 'session-extraction') return t('sourceKindSessionExtraction');
      if (kind === 'agent-inference') return t('sourceKindAgentInference');
      return null;
    }

    /** A candidate origin in words; unknown or absent is said plainly. */
    function originLabel(origin, t) {
      if (origin === 'rule') return t('originRule');
      if (origin === 'user') return t('originUser');
      if (origin === 'legacy') return t('originLegacy');
      if (origin === 'llm') return t('originLlm');
      return null;
    }

    /** One record state from a change entry; absent stays null rather than blank. */
    function recordView(value) {
      if (value === null || typeof value !== 'object') return null;
      return {
        content: typeof value.content === 'string' ? value.content : null,
        status: typeof value.status === 'string' ? value.status : null,
        type: typeof value.type === 'string' ? value.type : null,
      };
    }

    /** Recent-change rows for the Git trail; missing fields stay null. */
    function changeView(data) {
      const list = Array.isArray(data && data.changes) ? data.changes : [];
      return {
        head: data && typeof data.head === 'string' ? data.head : null,
        rows: list.map((entry) => {
          const source = entry && typeof entry === 'object' ? entry : {};
          return {
            commit: typeof source.commit === 'string' ? source.commit : null,
            committedAt: typeof source.committed_at === 'string' ? source.committed_at : null,
            changeId: typeof source.change_id === 'string' ? source.change_id : null,
            changeType: typeof source.change_type === 'string' ? source.change_type : null,
            actor: typeof source.actor === 'string' ? source.actor : null,
            reason: typeof source.reason === 'string' ? source.reason : '',
            memoryId: typeof source.memory_id === 'string' ? source.memory_id : null,
            content: typeof source.content === 'string' ? source.content : null,
            before: recordView(source.before),
            after: recordView(source.after),
          };
        }),
      };
    }

    /** Version timeline rows; missing fields stay null instead of being invented. */
    function versionView(data) {
      const list = Array.isArray(data && data.versions) ? data.versions : [];
      return {
        memoryId: data && typeof data.memoryId === 'string' ? data.memoryId : null,
        rows: list.map((entry) => {
          const source = entry && typeof entry === 'object' ? entry : {};
          return {
            version: Number.isInteger(source.version) ? source.version : null,
            changeId: typeof source.change_id === 'string' ? source.change_id : null,
            changeType: typeof source.change_type === 'string' ? source.change_type : null,
            reason: typeof source.reason === 'string' ? source.reason : '',
            committedAt: typeof source.committed_at === 'string' ? source.committed_at : null,
            content: typeof source.content === 'string' ? source.content : '',
          };
        }),
      };
    }

    /** Runtime queue rows; a missing field stays null instead of being invented. */
    function hostCandidateView(data, limit = 20) {
      const list = data && Array.isArray(data.candidates) ? data.candidates.slice(0, limit) : [];
      return {
        summary: data && data.summary && typeof data.summary === 'object' ? data.summary : null,
        rows: list.map((candidate) => {
          const source = candidate && typeof candidate === 'object' ? candidate : {};
          const classification = candidate && typeof candidate === 'object' && candidate.classification && typeof candidate.classification === 'object'
            ? candidate.classification
            : null;
          return {
            id: typeof source.id === 'string' ? source.id : '',
            text: typeof source.text === 'string' ? source.text : '',
            type: typeof source.type === 'string' ? source.type : null,
            status: typeof source.status === 'string' ? source.status : null,
            open: source.open === true,
            reason: typeof source.reason === 'string' ? source.reason : '',
            origin: typeof source.origin === 'string' ? source.origin : null,
            decision: classification && typeof classification.decision === 'string' ? classification.decision : null,
            policy: candidate && typeof candidate === 'object' && candidate.policy && typeof candidate.policy === 'object'
              ? { decision: typeof candidate.policy.decision === 'string' ? candidate.policy.decision : null, reasons: Array.isArray(candidate.policy.reasons) ? candidate.policy.reasons.slice(0, 3) : [] }
              : null,
            decisionTarget: classification && typeof classification.targetId === 'string' ? classification.targetId : null,
            refs: evidenceRefsOf(source),
            createdAt: typeof source.created_at === 'string' ? source.created_at : null,
          };
        }),
      };
    }

    /** One proposal action in words; unknown or absent stays silent. */
    function proposalActionLabel(action, t) {
      if (action === 'add') return t('proposalAdd');
      if (action === 'update') return t('proposalUpdate');
      if (action === 'merge') return t('proposalMerge');
      if (action === 'retract') return t('proposalRetract');
      return null;
    }

    /**
     * Rows for the proposal panel. The before text comes only from the ledger
     * row the user can already see; nothing is invented when the target is gone.
     */
    function proposalView(data, ledgerRows, limit = 10) {
      const list = data && Array.isArray(data.proposals) ? data.proposals : [];
      const known = new Map((Array.isArray(ledgerRows) ? ledgerRows : []).map((row) => [row.id, row]));
      return list.slice(0, limit).map((proposal) => {
        const source = proposal !== null && typeof proposal === 'object' ? proposal : {};
        const targetId = typeof source.target_memory_id === 'string' ? source.target_memory_id : null;
        const target = targetId === null ? null : known.get(targetId);
        return {
          id: typeof source.id === 'string' ? source.id : '',
          action: typeof source.action === 'string' ? source.action : null,
          status: typeof source.status === 'string' ? source.status : null,
          open: source.status === 'open',
          kind: typeof source.kind === 'string' ? source.kind : null,
          reason: typeof source.reason === 'string' ? source.reason : '',
          targetId,
          targetFound: targetId === null ? true : target !== undefined,
          currentContent: target !== null && target !== undefined && typeof target.text === 'string' ? target.text : '',
          proposedContent: typeof source.content === 'string' ? source.content : '',
          changeId: target !== null && target !== undefined && typeof target.changeId === 'string' ? target.changeId : null,
          createdAt: typeof source.created_at === 'string' ? source.created_at : null,
        };
      });
    }

    /** Rows for the read-only ledger list: what the memory store actually holds. */
    function ledgerView(memories, limit = 20) {
      if (!Array.isArray(memories)) return [];
      return memories.slice(0, limit).map((memory) => {
        const status = memory && typeof memory.status === 'string' ? memory.status : 'unknown';
        return {
          id: memory && memory.id ? String(memory.id) : '',
          text: memory && typeof memory.content === 'string' ? memory.content : '',
          active: status === 'active',
          status,
          // Only forwarded when the ledger actually stored it; never invented.
          type: memory && typeof memory.type === 'string' ? memory.type : null,
          refs: evidenceRefsOf(memory),
          sourceKind: memory && typeof memory.source_kind === 'string' ? memory.source_kind : null,
          changeId: memory && typeof memory.last_change_id === 'string' ? memory.last_change_id : null,
          version: memory && Number.isInteger(memory.version) ? memory.version : null,
          scope: memory && typeof memory.scope === 'string' ? memory.scope : null,
          tags: memory && Array.isArray(memory.tags) ? memory.tags.filter((tag) => typeof tag === 'string' && tag !== '') : [],
          entities: memory && Array.isArray(memory.entities) ? memory.entities.filter((entity) => typeof entity === 'string' && entity !== '') : [],
        };
      });
    }

    /** At most `limit` values plus a "+N" marker, so a row cannot grow without bound. */
    function badgeValues(values, limit = 3) {
      const list = Array.isArray(values) ? values : [];
      return { shown: list.slice(0, limit), rest: Math.max(0, list.length - limit) };
    }

    /** Case-insensitive text match across the fields the UI actually has. */
    function includesQuery(value, query) {
      return String(value ?? '').toLocaleLowerCase().includes(query);
    }

    /** Filter local or ledger memories by query, type and status. Absent fields never match a filter. */
    function filterMemories(memories, options = {}) {
      const list = Array.isArray(memories) ? memories : [];
      const query = String(options.query ?? '').trim().toLocaleLowerCase();
      const type = String(options.type ?? '');
      const status = String(options.status ?? '');
      return list.filter((memory) => {
        if (!memory || typeof memory !== 'object') return false;
        if (type !== '' && memory.type !== type) return false;
        if (status !== '' && memory.status !== status) return false;
        if (query === '') return true;
        const joined = (value) => (Array.isArray(value) ? value.join(' ') : '');
        return includesQuery(memory.content, query)
          || includesQuery(memory.text, query)
          || includesQuery(memory.id, query)
          || includesQuery(joined(memory.tags), query)
          || includesQuery(joined(memory.entities), query);
      });
    }

    /** Type values that really exist in the data; empty means "hide the type filter". */
    function memoryTypes(memories) {
      const seen = [];
      for (const memory of Array.isArray(memories) ? memories : []) {
        const type = memory && typeof memory.type === 'string' ? memory.type : null;
        if (type !== null && type !== '' && !seen.includes(type)) seen.push(type);
      }
      return seen.sort();
    }

    /**
     * Audit badges. `returned` only claims the Host returned text; it never claims
     * the model received or used it. Only a real true + evidence string confirms use.
     */
    function injectionBadges(record, t) {
      const source = record && typeof record === 'object' ? record : {};
      const state = typeof source.state === 'string' ? source.state : null;
      const badges = [];
      if (state === 'returned') badges.push({ key: 'state', text: t('traceStateReturned'), tone: 'info' });
      else if (state !== null) badges.push({ key: 'state', text: state, tone: 'info' });
      else badges.push({ key: 'state', text: t('notProvided'), tone: 'muted' });
      if (source.confirmed === true && typeof source.evidence === 'string' && source.evidence !== '') {
        badges.push({ key: 'confirmed', text: t('traceConfirmed'), tone: 'ok' });
      } else {
        badges.push({ key: 'confirmed', text: t('traceUnconfirmed'), tone: 'pending' });
      }
      return badges;
    }

    /** Detail rows for one record. Missing values read "not provided" instead of looking like zero. */
    function injectionRows(record, t) {
      const source = record && typeof record === 'object' ? record : {};
      const provided = (value, format) => (value === undefined || value === null ? t('notProvided') : format(value));
      const listOrMissing = (value, format) => (Array.isArray(value) && value.length > 0 ? value.map(format).join('；') : t('notProvided'));
      const pools = source.pools && typeof source.pools === 'object'
        ? [source.pools.constraint, source.pools.dynamic].map((pool, index) => {
          const label = index === 0 ? t('traceConstraint') : t('traceDynamic');
          if (!pool || typeof pool !== 'object') return `${label}: ${t('notProvided')}`;
          return `${label}: ${pool.used}/${pool.budget}`;
        }).join(' · ')
        : null;
      return [
        { key: 'snapshot', label: t('traceSnapshot'), value: provided(source.snapshot_head, (value) => String(value)) },
        { key: 'reasons', label: t('traceReasons'), value: listOrMissing(source.reasons, (value) => String(value)) },
        { key: 'pools', label: t('tracePools'), value: provided(pools, (value) => value) },
        { key: 'memories', label: t('traceMemories'), value: listOrMissing(source.memories, (entry) => {
          const id = entry && entry.id ? String(entry.id) : '?';
          const kind = entry && entry.kind === 'constraint' ? t('traceConstraint') : t('traceDynamic');
          const used = entry && Number.isInteger(entry.chars_used) ? ` · ${entry.chars_used}` : '';
          return `${id}（${kind}${used}）`;
        }) },
        { key: 'excluded', label: t('traceExcluded'), value: listOrMissing(source.excluded, (entry) => {
          const id = entry && entry.id ? String(entry.id) : '?';
          const reason = entry && entry.reason ? String(entry.reason) : t('notProvided');
          return `${id}: ${reason}`;
        }) },
      ];
    }

    /** Normalise a /injections answer into rows the panel can render. */
    function injectionView(data, t, limit = 50) {
      const records = data && Array.isArray(data.injections) ? data.injections.slice(0, limit) : [];
      return records.map((record, index) => {
        const source = record && typeof record === 'object' ? record : {};
        const key = typeof source.key === 'string' && source.key !== '' ? source.key : `row-${index}`;
        return {
          key,
          turn: Number.isInteger(source.turn) ? source.turn : null,
          chars: Number.isInteger(source.chars) ? source.chars : null,
          occurrences: Number.isInteger(source.occurrences) ? source.occurrences : null,
          badges: injectionBadges(source, t),
          details: injectionRows(source, t),
        };
      });
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

    /**
     * Injection trace. Loads lazily on first expand, so the page costs nothing
     * when nobody looks, and shows the raw audit fields without inventing any.
     */
    /**
     * Read the audit route without throwing: the panel needs a renderable state,
     * and a failed read must stay retryable instead of freezing the section.
     */
    async function loadInjections(fetchImpl) {
      if (typeof fetchImpl !== 'function') return { status: 'error', records: [], error: 'no-fetch' };
      let response;
      try {
        response = await fetchImpl(`${HOST_PREFIX}/injections?limit=50`, { headers: { accept: 'application/json' } });
      } catch (error) {
        return { status: 'error', records: [], error: error && error.name === 'AbortError' ? 'timeout' : 'network' };
      }
      let data = null;
      try { data = JSON.parse(await response.text()); } catch { data = null; }
      if (!response.ok || !data || data.ok !== true) {
        return { status: 'error', records: [], error: `http-${response.status}` };
      }
      return { status: 'ready', records: Array.isArray(data.injections) ? data.injections : [], error: null };
    }

    function InjectionPanel({ t }) {
      const [loaded, setLoaded] = useState(false);
      const [state, setState] = useState({ status: 'idle', records: [], error: null });
      const load = () => {
        setState({ status: 'loading', records: [], error: null });
        loadInjections(fetch).then(setState, () => setState({ status: 'error', records: [], error: 'network' }));
      };
      const rows = injectionView({ injections: state.records }, t);
      return h('details', {
        className: 'dm-trace',
        onToggle: (event) => {
          if (!event.currentTarget.open || loaded) return;
          setLoaded(true);
          load();
        },
      },
        h('summary', null, t('traceTitle').replace('{count}', state.status === 'ready' ? String(rows.length) : '—')),
        h('p', { className: 'dm-trace-hint' }, t('traceHint')),
        state.status === 'loading' || state.status === 'idle'
          ? h('div', { className: 'dm-loading', role: 'status' },
            h('p', { className: 'dm-muted dm-loading-text' }, t('traceLoading')),
            h('div', { className: 'dm-skeleton', 'aria-hidden': true }))
          : null,
        state.status === 'error'
          ? h('div', { className: 'dm-notice dm-error', role: 'alert' },
            h('strong', null, t('traceError')),
            h('p', null, state.error),
            h('button', { type: 'button', className: 'dm-link', onClick: load }, t('retry')))
          : null,
        state.status === 'ready' && rows.length === 0
          ? h('p', { className: 'dm-muted' }, t('traceEmpty'))
          : null,
        state.status === 'ready' && rows.length > 0
          ? h('div', { className: 'dm-trace-actions' },
            h('button', { type: 'button', className: 'dm-refresh dm-quiet', onClick: load }, t('refresh')))
          : null,
        state.status === 'ready' && rows.length > 0
          ? h('ol', { className: 'dm-trace-list' }, rows.map((row) => h('li', { key: row.key, className: 'dm-trace-row' },
            h('div', { className: 'dm-trace-head' },
              h('span', { className: 'dm-trace-turn' }, `${t('traceTurn')} ${row.turn === null ? '—' : row.turn}`),
              h('span', { className: 'dm-trace-meta' }, `${row.chars === null ? '—' : row.chars} ${t('traceChars')} · ${row.occurrences === null ? '—' : row.occurrences} ${t('traceCalls')}`),
              h('span', { className: 'dm-badges' }, row.badges.map((badge) => h('span', { key: badge.key, className: `dm-badge dm-badge-${badge.tone}` }, badge.text)))),
            h('dl', { className: 'dm-trace-fields' }, row.details.map((detail) => h(React.Fragment, { key: detail.key },
              h('dt', null, detail.label), h('dd', null, detail.value)))))))
          : null);
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
      const [pingPending, setPingPending] = useState(false);
      const [migrating, setMigrating] = useState(false);
      const [host, setHost] = useState({ status: 'probing', count: 0, head: null, reason: '' });
      /** Ledger contents read from the Host, shown read-only beside the local store. */
      const [ledger, setLedger] = useState([]);
      /** Host runtime candidate queue: reads and reviews both go through the Host. */
      const [hostQueue, setHostQueue] = useState({ status: 'idle', rows: [], error: null });
      const loadHostQueue = () => {
        if (typeof fetch !== 'function') {
          setHostQueue({ status: 'idle', rows: [], error: null });
          setChanges({ status: 'idle', rows: [], head: null });
          return;
        }
        createHostClient(fetch).candidates().then((queue) => {
          const view = hostCandidateView(queue);
          setHostQueue({ status: 'ready', rows: view.rows, error: null });
        }, () => setHostQueue({ status: 'error', rows: [], error: 'network' }));
      };
      const [changes, setChanges] = useState({ status: 'idle', rows: [], head: null });
      const loadChanges = () => {
        if (typeof fetch !== 'function') {
          setChanges({ status: 'idle', rows: [], head: null });
          return;
        }
        createHostClient(fetch).changes({ limit: 20 }).then((data) => {
          const view = changeView(data);
          setChanges({ status: 'ready', rows: view.rows, head: view.head });
        }, () => setChanges({ status: 'error', rows: [], head: null }));
      };
      /** Suppression from the Host runtime: objections, not ledger content. */
      const [objections, setObjections] = useState({ status: 'idle', rows: [], suppressed: [], kinds: [], reviewPending: [] });
      const [objectionKind, setObjectionKind] = useState('wrong');
      const [objectingId, setObjectingId] = useState(null);
      /** The Host's automatic-memory switches; never assumed, always read. */
      const [hostSettings, setHostSettings] = useState({ status: 'idle', settings: null, error: null });
      const loadHostSettings = () => {
        if (typeof fetch !== 'function') {
          setHostSettings({ status: 'idle', settings: null, error: null });
          setProposals({ status: 'idle', rows: [] });
          return;
        }
        createHostClient(fetch).settings().then((data) => {
          setHostSettings({
            status: 'ready',
            settings: data && typeof data === 'object' && data.settings && typeof data.settings === 'object'
              ? { enabled: data.settings.enabled === true, autoAccept: data.settings.autoAccept === true }
              : null,
            error: null,
          });
        }, () => setHostSettings({ status: 'error', settings: null, error: 'network' }));
      };
      const saveHostSettings = (next) => {
        if (typeof fetch !== 'function') return;
        createHostClient(fetch).saveSettings(next).then((data) => {
          setHostSettings({
            status: 'ready',
            settings: data && typeof data === 'object' && data.settings && typeof data.settings === 'object'
              ? { enabled: data.settings.enabled === true, autoAccept: data.settings.autoAccept === true }
              : null,
            error: null,
          });
          setNotice(t('settingsSaved'));
        }, () => setNotice(t('settingsFailed')));
      };
      /** Open AI proposals: read-only until the user decides. */
      const [proposals, setProposals] = useState({ status: 'idle', rows: [] });
      const loadProposals = () => {
        if (typeof fetch !== 'function') {
          setProposals({ status: 'idle', rows: [] });
          return;
        }
        createHostClient(fetch).proposals().then((data) => {
          setProposals({ status: 'ready', rows: proposalView(data, ledger) });
        }, () => setProposals({ status: 'error', rows: [] }));
      };
      const loadObjections = () => {
        if (typeof fetch !== 'function') {
          setObjections({ status: 'idle', rows: [], suppressed: [], kinds: [], reviewPending: [] });
          return;
        }
        createHostClient(fetch).objections().then((data) => {
          setObjections({
            status: 'ready',
            rows: Array.isArray(data.objections) ? data.objections : [],
            suppressed: Array.isArray(data.suppressed) ? data.suppressed : [],
            kinds: Array.isArray(data.kinds) ? data.kinds.filter((kind) => typeof kind === 'string') : [],
            reviewPending: Array.isArray(data.review_pending) ? data.review_pending.filter((id) => typeof id === 'string') : [],
          });
        }, () => setObjections({ status: 'error', rows: [], suppressed: [], kinds: [], reviewPending: [] }));
      };
      const [query, setQuery] = useState('');
      const [typeFilter, setTypeFilter] = useState('');
      /** Original-evidence branch: idle, loading, ready, missing or unavailable. */
      const [evidence, setEvidence] = useState({ status: 'idle', turn: null, ref: null });
      const openEvidence = (memory) => {
        const refs = evidenceRefsOf(memory);
        if (refs.length === 0) { setNotice(t('evidenceMissing')); return; }
        const ref = refs[0];
        setEvidence({ status: 'loading', turn: null, ref });
        const controller = new AbortController();
        const load = async () => {
          if (!sessions || typeof sessions.retain !== 'function') {
            setEvidence({ status: 'unavailable', turn: null, ref });
            return;
          }
          let reference;
          try {
            reference = sessions.retain(ref.session_id, { source: 'memory-evidence', signal: controller.signal });
            await reference.ready;
            await loadFullHistory(reference, controller.signal);
            const grouped = groupTurns(ref.session_id, sessionEvents(reference.binding));
            const turn = locateTurnForEvent(grouped.map((item) => evidenceTurn(ref.session_id, item)), ref);
            setEvidence(turn ? { status: 'ready', turn, ref } : { status: 'missing', turn: null, ref });
          } catch {
            setEvidence({ status: 'unavailable', turn: null, ref });
          } finally {
            if (reference && typeof reference.release === 'function') reference.release();
          }
        };
        load();
      };
      const probeHost = () => {
        if (typeof fetch !== 'function') {
          setHost({ status: 'offline', count: 0, head: null, reason: 'no-fetch' });
          return;
        }
        setHost({ status: 'probing', count: 0, head: null, reason: '' });
        createHostClient(fetch).state().then((data) => {
          setHost({ status: 'ok', count: data.memories.length, head: data.head, reason: '' });
          setLedger(data.memories);
          loadHostQueue();
          loadChanges();
          loadObjections();
          loadHostSettings();
          loadProposals();
        }, (error) => {
          setHost({ status: 'offline', count: 0, head: null, reason: (error && error.reason) || 'network' });
          setLedger([]);
          setHostQueue({ status: 'idle', rows: [], error: null });
          setObjections({ status: 'idle', rows: [], suppressed: [], kinds: [] });
          setHostSettings({ status: 'idle', settings: null, error: null });
        });
      };
      useEffect(() => { probeHost(); }, []);
      const testHost = () => {
        if (pingPending) return;
        setPingPending(true);
        setPing(t('pingWaiting'));
        const failed = (status) => setPing(t('pingFailed').replace('{status}', String(status)));
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        let request;
        try {
          request = fetch(`${HOST_PREFIX}/ping`, { headers: { accept: 'application/json' }, signal: controller.signal });
        } catch {
          // A synchronous throw must not leave the button disabled forever.
          clearTimeout(timer);
          setPingPending(false);
          setPing(t('pingFailed').replace('{status}', 'network'));
          return;
        }
        request
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
          .then(() => { clearTimeout(timer); setPingPending(false); }, () => { clearTimeout(timer); setPingPending(false); });
      };
      const migrateToHost = () => {
        if (migrating || host.status !== 'ok' || typeof fetch !== 'function') return;
        setMigrating(true);
        setNotice(t('migrateSending'));
        const client = createHostClient(fetch);
        client.migrate({ memories: loadStored(FORMAL_KEY), candidates: loadStored(CANDIDATES_KEY) }).then((result) => {
          setMigrating(false);
          setNotice(migrationSummary(result, t));
          probeHost();
        }, (error) => {
          setMigrating(false);
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
      // Filters only ever narrow real data; they never invent a category.
      const activeMemories = memories.filter((memory) => memory.status === 'active');
      const typeOptions = memoryTypes([...activeMemories, ...ledger]);
      const shownMemories = filterMemories(activeMemories, { query, type: typeFilter });
      const shownLedger = ledgerView(filterMemories(ledger, { query, type: typeFilter }), 20);
      const filtersActive = query.trim() !== '' || typeFilter !== '';
      const pendingCandidateCount = candidates.filter((candidate) => candidate.status === 'candidate').length;
      const migratable = memories.length + pendingCandidateCount;
      const toolbar = activeMemories.length > 0 || ledger.length > 0
        ? h('div', { className: 'dm-toolbar' },
          h('label', { className: 'dm-field' },
            h('span', { className: 'dm-field-label' }, t('search')),
            h('input', {
              className: 'dm-input',
              type: 'search',
              value: query,
              placeholder: t('search'),
              onChange: (event) => setQuery(event.target.value),
            })),
          typeOptions.length > 0
            ? h('label', { className: 'dm-field' },
              h('span', { className: 'dm-field-label' }, t('filterType')),
              h('select', { className: 'dm-input', value: typeFilter, onChange: (event) => setTypeFilter(event.target.value) },
                h('option', { value: '' }, t('filterAll')),
                typeOptions.map((type) => h('option', { key: type, value: type }, type))))
            : null,
          filtersActive
            ? h('button', { type: 'button', className: 'dm-link', onClick: () => { setQuery(''); setTypeFilter(''); } }, t('searchClear'))
            : null)
        : null;
      /** Ledger edit and retract go through the Host writer; nothing is written locally. */
      const [ledgerDraft, setLedgerDraft] = useState(null);
      const [retractId, setRetractId] = useState(null);
      const [ledgerPending, setLedgerPending] = useState(false);
      const ledgerError = (reason) => (reason === 'stale' ? 'versionChanged'
        : reason === 'busy' || reason === 'ledger-dirty' ? 'hostBusy'
          : reason === 'missing' ? 'missingMemory' : 'saveFailed');
      const saveLedgerEdit = () => {
        if (!ledgerDraft || ledgerPending || typeof fetch !== 'function') return;
        const content = String(ledgerDraft.content ?? '').trim();
        if (content === '') { setLedgerDraft({ ...ledgerDraft, error: 'emptyContent' }); return; }
        setLedgerPending(true);
        const answered = objections.reviewPending.includes(ledgerDraft.id);
        createHostClient(fetch).update({
          memoryId: ledgerDraft.id,
          content,
          expectedBaseChangeId: ledgerDraft.changeId,
          clearObjection: answered,
        }).then(() => {
          setLedgerPending(false);
          setLedgerDraft(null);
          setNotice(t('saved'));
          probeHost();
        }, (error) => {
          setLedgerPending(false);
          setLedgerDraft((old) => (old ? { ...old, error: ledgerError(error && error.reason) } : old));
        });
      };
      const retractLedger = (row) => {
        if (ledgerPending || typeof fetch !== 'function') return;
        setLedgerPending(true);
        createHostClient(fetch).retract({ memoryId: row.id, expectedBaseChangeId: row.changeId }).then(() => {
          setLedgerPending(false);
          setRetractId(null);
          setNotice(t('retracted'));
          probeHost();
        }, (error) => {
          setLedgerPending(false);
          setRetractId(null);
          setNotice(t('retractFailed').replace('{reason}', String((error && error.reason) || 'network')));
        });
      };
      const reviewProposalRow = (row, action) => {
        if (ledgerPending || typeof fetch !== 'function') return;
        if (action === 'accept' && row.targetId !== null && !row.targetFound) {
          setNotice(t('proposalMissingTarget'));
          return;
        }
        if (action === 'accept' && row.action !== 'add' && row.changeId === null) {
          setNotice(t('proposalStale'));
          return;
        }
        setLedgerPending(true);
        createHostClient(fetch).reviewProposal({
          proposalId: row.id,
          action,
          expectedBaseChangeId: action === 'accept' && row.action !== 'add' ? row.changeId : undefined,
        }).then(() => {
          setLedgerPending(false);
          setNotice(action === 'accept' ? t('proposalAccepted') : t('proposalRejected'));
          probeHost();
        }, (error) => {
          setLedgerPending(false);
          const reason = String((error && error.reason) || 'network');
          setNotice(reason === 'stale' ? t('proposalStale') : t('proposalFailed').replace('{reason}', reason));
        });
      };
      const markObjection = (id) => {
        if (ledgerPending || typeof fetch !== 'function') return;
        setLedgerPending(true);
        createHostClient(fetch).object({ memoryId: id, kind: objectionKind }).then(() => {
          setLedgerPending(false);
          setObjectingId(null);
          setNotice(t('objectedDone'));
          loadObjections();
        }, () => {
          setLedgerPending(false);
          setObjectingId(null);
          setNotice(t('objectFailed'));
        });
      };
      const reinstateObjection = (id) => {
        if (ledgerPending || typeof fetch !== 'function') return;
        setLedgerPending(true);
        createHostClient(fetch).clearObjection({ memoryId: id }).then(() => {
          setLedgerPending(false);
          setNotice(t('reinstateDone'));
          loadObjections();
        }, () => {
          setLedgerPending(false);
          setNotice(t('objectFailed'));
        });
      };
      const changeDiffLine = (row, t) => {
        const before = row.before;
        const after = row.after;
        if (before === null || after === null) return null;
        const parts = [];
        if (before.content !== after.content) parts.push((before.content ?? '') + ' → ' + (after.content ?? ''));
        if (before.status !== after.status) parts.push(t('changeStatus').replace('{before}', String(before.status ?? ''))
          .replace('{after}', String(after.status ?? '')));
        if (parts.length === 0) return null;
        return h('span', { className: 'dm-muted dm-change-diff' }, parts.join(' · '));
      };
      const ledgerBadges = (values, className) => {
        const { shown, rest } = badgeValues(values);
        if (shown.length === 0) return null;
        return [
          ...shown.map((value) => h('span', { key: className + value, className }, value)),
          rest > 0 ? h('span', { key: className + '-rest', className: 'dm-badge dm-badge-muted' }, '+' + rest) : null,
        ];
      };
      const ledgerItem = (row) => h('li', { key: row.id, className: 'dm-ledger-row' },
        h('div', { className: 'dm-ledger-line' },
          sourceKindLabel(row.sourceKind, t) === null ? null : h('span', { className: 'dm-badge dm-badge-muted' }, sourceKindLabel(row.sourceKind, t)),
          h('span', { className: 'dm-type dm-type-' + (row.type === 'constraint' ? 'constraint' : 'plain') }, row.type === null ? t('notProvided') : row.type),
          h('span', { className: 'dm-muted' }, (row.active ? t('ledgerActive') : t('ledgerInactive')) + ' · ' + row.text),
          ledgerBadges(row.entities, 'dm-badge dm-badge-muted'),
          ledgerBadges(row.tags.map((tag) => '#' + tag), 'dm-badge dm-badge-tag')),
        ledgerDraft && ledgerDraft.id === row.id
          ? h('form', {
            className: 'dm-ledger-edit',
            onSubmit: (event) => { event.preventDefault(); saveLedgerEdit(); },
          },
            h('textarea', {
              className: 'dm-textarea',
              value: ledgerDraft.content,
              rows: 4,
              onChange: (event) => setLedgerDraft({ ...ledgerDraft, content: event.target.value, error: '' }),
            }),
            h('div', { className: 'dm-review-actions' },
              h('button', { type: 'submit', className: 'dm-refresh', disabled: ledgerPending || textSubmitDisabled(ledgerDraft.content) }, t('saveEdit')),
              h('button', { type: 'button', className: 'dm-back', onClick: () => setLedgerDraft(null) }, t('cancel'))),
            ledgerDraft.error ? h('p', { className: 'dm-muted', role: 'alert' }, t(ledgerDraft.error)) : null)
          : h('div', { className: 'dm-ledger-actions' },
            ledgerEvidenceButton(row, t, openEvidence),
            objections.suppressed.includes(row.id)
              ? h('span', { className: 'dm-badge dm-badge-bad' }, t('objected'))
              : null,
            objections.reviewPending.includes(row.id)
              ? h('span', { className: 'dm-badge dm-badge-pending' }, t('reviewPendingBadge'))
              : null,
            row.active && objections.suppressed.includes(row.id)
              ? h('button', { type: 'button', className: 'dm-link', disabled: ledgerPending, onClick: () => reinstateObjection(row.id) }, t(objections.reviewPending.includes(row.id) ? 'acceptAsIs' : 'reinstate'))
              : null,
            row.active && !objections.suppressed.includes(row.id)
              ? (objectingId === row.id
                ? h(React.Fragment, null,
                  h('select', {
                    className: 'dm-input dm-objection-kind',
                    'aria-label': t('objectKind'),
                    value: objectionKind,
                    disabled: ledgerPending,
                    onChange: (event) => setObjectionKind(event.target.value),
                  }, (objections.kinds.length > 0 ? objections.kinds : ['wrong']).map((kind) => h('option', { key: kind, value: kind },
                    correctionLabel(kind, t) === null ? kind : correctionLabel(kind, t)))),
                  h('button', { type: 'button', className: 'dm-link dm-danger', disabled: ledgerPending, onClick: () => markObjection(row.id) }, t('objectConfirm')),
                  h('button', { type: 'button', className: 'dm-link', onClick: () => setObjectingId(null) }, t('cancel')))
                : h('button', { type: 'button', className: 'dm-link', onClick: () => setObjectingId(row.id) }, t('object')))
              : null,
            row.active
              ? h('button', { type: 'button', className: 'dm-link', onClick: () => setLedgerDraft({ id: row.id, content: row.text, changeId: row.changeId, error: '' }) }, t('edit'))
              : null,
            h('button', { type: 'button', className: 'dm-link', onClick: () => openHistory(row) }, t('history')),
            row.active && retractId === row.id
              ? h(React.Fragment, null,
                h('button', { type: 'button', className: 'dm-link dm-danger', disabled: ledgerPending, onClick: () => retractLedger(row) }, t('confirmRetract')),
                h('button', { type: 'button', className: 'dm-link', onClick: () => setRetractId(null) }, t('cancel')))
              : row.active
                ? h('button', { type: 'button', className: 'dm-link', onClick: () => setRetractId(row.id) }, t('retract'))
                : null),
        history.id === row.id ? historyBlock(row) : null);

      /** Accept/reject run on the Host queue, so a review lands in the single writer. */
      const [queuePending, setQueuePending] = useState(null);
      const reviewHostCandidate = (row, action) => {
        if (queuePending !== null || typeof fetch !== 'function') return;
        setQueuePending(row.id);
        createHostClient(fetch).review({ candidateId: row.id, action }).then(() => {
          setQueuePending(null);
          setNotice(action === 'accept' ? t('hostCandidateAccepted') : t('hostCandidateRejected'));
          loadHostQueue();
          probeHost();
        }, (error) => {
          setQueuePending(null);
          setNotice(t('hostCandidateFailed').replace('{reason}', String((error && error.reason) || 'network')));
        });
      };
      const hostQueueItem = (row) => h('li', { key: row.id, className: 'dm-host-queue-row' },
        h('span', { className: 'dm-type dm-type-' + (row.type === 'constraint' ? 'constraint' : 'plain') }, row.type === null ? t('notProvided') : row.type),
        h('span', { className: 'dm-badge dm-badge-' + (row.open === true ? 'pending' : row.status === 'auto_accepted' || row.status === 'accepted_by_user' ? 'ok' : row.status === 'rejected' || row.status === 'failed' ? 'bad' : 'muted') }, row.status === null ? t('notProvided') : (candidateStatusLabel(row.status, t) === null ? row.status : candidateStatusLabel(row.status, t))),
        h('span', { className: 'dm-muted' }, row.text),
        row.reason === '' ? null : h('span', { className: 'dm-muted' }, row.reason),
        originLabel(row.origin, t) === null ? null : h('span', { className: 'dm-badge dm-badge-muted' }, t('origin') + ' · ' + originLabel(row.origin, t)),
        decisionLabel(row.decision, t) === null ? null : h('span', { className: 'dm-badge dm-badge-' + (row.decision === 'ADD' ? 'ok' : row.decision === 'CONFLICT' ? 'pending' : 'muted') },
          decisionLabel(row.decision, t) + (row.decisionTarget === null ? '' : ' · ' + t('decisionTarget').replace('{id}', row.decisionTarget))),
        policyLabel(row.policy, t) === null ? null : h('span', { className: 'dm-badge dm-badge-' + (row.policy.decision === 'AUTO_ACCEPT' ? 'ok' : row.policy.decision === 'REJECT' ? 'bad' : 'muted') },
          t('policy') + ' · ' + policyLabel(row.policy, t)),
        ledgerEvidenceButton({ refs: row.refs }, t, openEvidence),
        row.open === true
          ? h('span', { className: 'dm-host-queue-actions' },
            h('button', { type: 'button', className: 'dm-link', disabled: queuePending === row.id, onClick: () => reviewHostCandidate(row, 'accept') }, t('accept')),
            h('button', { type: 'button', className: 'dm-link dm-danger', disabled: queuePending === row.id, onClick: () => reviewHostCandidate(row, 'reject') }, t('reject')))
          : null);

      /** Version timeline of the row whose history is open; read-only. */
      const [history, setHistory] = useState({ id: null, status: 'idle', rows: [] });
      const openHistory = (row) => {
        if (history.id === row.id) {
          setHistory({ id: null, status: 'idle', rows: [] });
          return;
        }
        if (typeof fetch !== 'function') {
          setHistory({ id: row.id, status: 'error', rows: [] });
          return;
        }
        setHistory({ id: row.id, status: 'loading', rows: [] });
        createHostClient(fetch).history({ memoryId: row.id }).then((data) => {
          setHistory({ id: row.id, status: 'ready', rows: versionView(data).rows });
        }, () => setHistory({ id: row.id, status: 'error', rows: [] }));
      };
      const historyBlock = (row) => h('div', { className: 'dm-history' },
        history.status === 'loading'
          ? h('p', { className: 'dm-muted' }, t('historyLoading'))
          : history.status === 'error'
            ? h('p', { className: 'dm-muted', role: 'alert' }, t('historyError'))
            : history.rows.length === 0
              ? h('p', { className: 'dm-muted' }, t('historyEmpty'))
              : h('ol', { className: 'dm-history-list' }, history.rows.map((entry, index) => h('li', { key: (entry.changeId || 'v') + String(index), className: 'dm-history-item' },
                h('p', { className: 'dm-muted dm-history-head' }, t('historyVersion').replace('{version}', String(entry.version === null ? index + 1 : entry.version))
                  + ' · ' + (entry.changeType === null ? t('notProvided') : entry.changeType)
                  + (entry.committedAt === null ? '' : ' · ' + entry.committedAt)),
                entry.reason === '' ? null : h('p', { className: 'dm-muted' }, entry.reason),
                h('pre', { className: 'dm-diff' }, diffLines(index === 0 ? '' : history.rows[index - 1].content, entry.content)
                  .map((line, lineIndex) => h('code', { key: String(lineIndex), className: 'dm-diff-' + line.kind },
                    (line.kind === 'add' ? '+ ' : line.kind === 'del' ? '- ' : '  ') + line.text + '\n')))))));

      if (evidence.status === 'ready' && evidence.turn) {
        return h('section', { className: 'dm-page' },
          h(ConversationView, {
            turn: evidence.turn, timeZone: data && data.time_zone, t,
            highlightSeq: evidence.ref ? evidence.ref.event_seq : null,
            onBack: () => setEvidence({ status: 'idle', turn: null, ref: null }),
            onSaved: (next) => { setCandidates(next); setNotice(t('saved')); },
          }));
      }
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
              className: 'dm-refresh dm-quiet',
              disabled: pingPending,
              onClick: testHost,
            }, t('testHost')),
            h('button', {
              type: 'button',
              className: 'dm-refresh dm-primary',
              disabled: state.status === 'loading',
              onClick: () => setRevision((value) => value + 1),
            }, t(state.status === 'error' ? 'retry' : 'refresh')))),
        h('main', { className: 'dm-content' },
          notice ? h('p', { className: 'dm-notice-line', role: 'status' }, notice) : null,
          h('p', { className: 'dm-statusline', role: 'status', 'data-status': host.status },
            h('span', { className: 'dm-dot', 'aria-hidden': true }),
            h('span', null, hostLine(host, t))),
          host.status === 'ok' && migratable > 0
            ? h('button', { type: 'button', className: 'dm-refresh', disabled: migrating, onClick: migrateToHost }, t('migrateButton').replace('{count}', String(migratable)))
            : null,
          host.status === 'ok' && proposals.status === 'ready' && proposals.rows.some((row) => row.open)
            ? h('section', { className: 'dm-proposals' },
              h('p', { className: 'dm-muted' }, t('proposalsTitle').replace('{count}', String(proposals.rows.filter((row) => row.open).length))),
              h('p', { className: 'dm-muted' }, t('proposalsHint')),
              h('ul', { className: 'dm-proposal-list' }, proposals.rows.filter((row) => row.open).map((row) => h('li', { key: row.id, className: 'dm-proposal-row' },
                h('span', { className: 'dm-badge dm-badge-pending' }, proposalActionLabel(row.action, t) === null ? String(row.action) : proposalActionLabel(row.action, t)),
                row.targetId === null ? null : h('span', { className: 'dm-muted' }, row.targetId),
                correctionLabel(row.kind, t) === null ? null : h('span', { className: 'dm-badge dm-badge-muted' }, correctionLabel(row.kind, t)),
                row.reason === '' ? null : h('span', { className: 'dm-muted' }, row.reason),
                row.action === 'retract'
                  ? h('p', { className: 'dm-muted' }, t('proposalBefore') + '：' + row.currentContent)
                  : h('div', null,
                    h('p', { className: 'dm-muted' }, t('proposalBefore') + ' / ' + t('proposalAfter')),
                    h('pre', { className: 'dm-diff' }, diffLines(row.currentContent, row.proposedContent)
                      .map((line, index) => h('code', { key: String(index), className: 'dm-diff-' + line.kind },
                        (line.kind === 'add' ? '+ ' : line.kind === 'del' ? '- ' : '  ') + line.text + '\n')))),
                h('span', { className: 'dm-host-queue-actions' },
                  h('button', { type: 'button', className: 'dm-link', disabled: ledgerPending, onClick: () => reviewProposalRow(row, 'accept') }, t('proposalAccept')),
                  h('button', { type: 'button', className: 'dm-link dm-danger', disabled: ledgerPending, onClick: () => reviewProposalRow(row, 'reject') }, t('proposalReject')))))))
            : null,
          host.status === 'ok' && hostSettings.status === 'ready' && hostSettings.settings !== null
            ? h('section', { className: 'dm-settings' },
              h('p', { className: 'dm-muted' }, t('settingsTitle')),
              h('label', { className: 'dm-setting-row' },
                h('input', {
                  type: 'checkbox',
                  checked: hostSettings.settings.enabled,
                  onChange: (event) => saveHostSettings({ enabled: event.target.checked }),
                }),
                h('span', null, t('settingsOn'))),
              h('label', { className: 'dm-setting-row' },
                h('input', {
                  type: 'checkbox',
                  checked: hostSettings.settings.autoAccept,
                  disabled: !hostSettings.settings.enabled,
                  onChange: (event) => saveHostSettings({ autoAccept: event.target.checked }),
                }),
                h('span', null, t('settingsAutoAccept'))),
              h('p', { className: 'dm-muted' }, t('settingsHint')))
            : null,
          host.status === 'ok' && hostQueue.status === 'error'
            ? h('p', { className: 'dm-muted', role: 'alert' }, t('hostCandidatesError'))
            : null,
          host.status === 'ok' && hostQueue.status === 'ready'
            ? h('section', { className: 'dm-host-queue' },
              h('p', { className: 'dm-muted' }, t('hostCandidates').replace('{count}', String(hostQueue.rows.length))),
              h('p', { className: 'dm-muted' }, t('hostCandidatesHint')),
              hostQueue.rows.length === 0
                ? h('p', { className: 'dm-muted' }, t('hostCandidatesEmpty'))
                : h('ul', { className: 'dm-host-queue-list' }, hostQueue.rows.map((row) => hostQueueItem(row))))
            : null,
          host.status === 'ok' && changes.status === 'error'
            ? h('p', { className: 'dm-muted', role: 'alert' }, t('recentChangesError'))
            : null,
          host.status === 'ok' && changes.status === 'ready'
            ? h('section', { className: 'dm-changes' },
              h('p', { className: 'dm-muted' }, t('recentChanges').replace('{count}', String(changes.rows.length))),
              changes.head === null ? null : h('p', { className: 'dm-muted dm-changes-head' }, t('ledgerHead').replace('{head}', changes.head.slice(0, 12))),
              changes.rows.length === 0
                ? h('p', { className: 'dm-muted' }, t('recentChangesEmpty'))
                : h('ul', { className: 'dm-changes-list' }, changes.rows.map((row, index) => h('li', { key: (row.changeId || 'c') + String(index), className: 'dm-changes-row' },
                  h('span', { className: 'dm-badge dm-badge-' + (row.changeType === 'ADD' ? 'ok' : row.changeType === 'RETRACT' ? 'muted' : 'pending') }, row.changeType === null ? t('notProvided') : row.changeType),
                  h('span', { className: 'dm-muted' }, row.memoryId === null ? t('notProvided') : row.memoryId),
                  row.reason === '' ? null : h('span', { className: 'dm-muted' }, row.reason),
                  changeDiffLine(row, t),
                h('span', { className: 'dm-muted dm-changes-time' }, row.committedAt === null ? t('notProvided') : row.committedAt),
                  h('span', { className: 'dm-muted dm-changes-commit' }, row.commit === null ? '' : row.commit.slice(0, 7))))))
            : null,
          host.status === 'ok' && shownLedger.length > 0
            ? h('section', { className: 'dm-ledger' },
              h('p', { className: 'dm-muted' }, t('ledgerTitle').replace('{count}', String(shownLedger.length))),
              h('ul', { className: 'dm-ledger-list' }, shownLedger.map((row) => ledgerItem(row))))
            : null,
          h(InjectionPanel, { t }),
          ping ? h('p', { className: 'dm-muted', role: 'status' }, ping) : null,
          evidence.status === 'loading'
            ? h('div', { className: 'dm-loading', role: 'status' },
              h('p', { className: 'dm-muted dm-loading-text' }, t('evidenceLoading')),
              h('div', { className: 'dm-skeleton', 'aria-hidden': true }))
            : null,
          evidence.status === 'missing' || evidence.status === 'unavailable'
            ? h('div', { className: 'dm-notice dm-error', role: 'alert' },
              h('strong', null, evidence.status === 'missing' ? t('evidenceOutside') : t('evidenceUnavailable')),
              evidence.ref ? h('p', null, evidence.ref.session_id + ' · seq ' + evidence.ref.event_seq) : null,
              h('button', { type: 'button', className: 'dm-link', onClick: () => setEvidence({ status: 'idle', turn: null, ref: null }) }, t('cancel')))
            : null,
          state.status === 'error'
            ? h('div', { className: 'dm-notice dm-error', role: 'alert' },
              h('strong', null, t('readError')), h('p', null, state.error))
            : null,
          state.status === 'loading' && !data
            ? h('div', { className: 'dm-loading', role: 'status' },
              h('p', { className: 'dm-muted dm-loading-text' }, t('loading')),
              h('div', { className: 'dm-skeleton', 'aria-hidden': true }),
              h('div', { className: 'dm-skeleton dm-skeleton-short', 'aria-hidden': true }))
            : null,
          toolbar,
          data
            ? h(React.Fragment, null,
              filtersActive && shownMemories.length === 0 && shownLedger.length === 0
                ? h('p', { className: 'dm-muted dm-filter-empty', role: 'status' }, t('filterEmpty'))
                : null,
              shownMemories.length > 0
                ? h('details', { className: 'dm-memory-bank' },
                  h('summary', null, t('formal').replace('{count}', shownMemories.length)),
                  shownMemories.map((memory) => h(MemoryCard, {
                    key: `${memory.id}-${memory.version}`,
                    memory,
                    history: memories
                      .filter((older) => older.id === memory.id && older.status === 'superseded')
                      .sort((left, right) => right.version - left.version),
                    t,
                    onSaved: (result) => { setMemories(result.memories); setNotice(t('saved')); },
                    onEvidence: openEvidence,
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
      .dm-refresh{flex:none;display:inline-flex;align-items:center;justify-content:center;gap:4px;min-height:30px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:8px;padding:6px 12px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer;font:inherit;font-size:12px}
      .dm-primary{background:var(--dsw-alias-bg-layer-2);font-weight:500}
      .dm-quiet{color:var(--dsw-alias-label-secondary)}
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
      .dm-conversation{height:100%;display:flex;flex-direction:column;padding:24px 0}.dm-back{align-self:flex-start;display:inline-flex;align-items:center;min-height:26px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;font-size:13px;padding:2px 6px;margin-left:-6px}
      .dm-back:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
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
      @media(max-width:600px){.dm-header{flex-wrap:wrap}.dm-status{margin-left:0}.dm-dayline{align-items:flex-start;flex-direction:column;gap:4px}.dm-actions{flex-wrap:wrap}}

      /* ---- design tokens: one scale for spacing, radius and elevation ---- */
      .dm-page{--dm-r-sm:8px;--dm-r-md:12px;--dm-r-lg:16px;--dm-space-1:4px;--dm-space-2:8px;--dm-space-3:12px;--dm-space-4:16px;--dm-space-5:24px;--dm-shadow-1:0 1px 2px rgba(15,23,42,.05)}
      .dm-card,.dm-message,.dm-turn-box,.dm-memory-bank article{box-shadow:var(--dm-shadow-1)}
      .dm-card,.dm-message,.dm-turn-box{border-radius:var(--dm-r-md)}
      .dm-memory-bank article{border-radius:var(--dm-r-md)}

      /* ---- focus: every interactive element gets the same visible ring ---- */
      .dm-page :is(button, a, summary, select, textarea, [tabindex]):focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px;border-radius:var(--dm-r-sm)}
      .dm-link:hover,.dm-remember:hover,.dm-memory-bank>summary:hover{color:var(--dsw-alias-label-primary)}
      .dm-remember:hover{background:var(--dsw-alias-interactive-bg-hover)}

      /* ---- overflow: long ids, digests and unbroken text never widen the page ---- */
      .dm-header>div,.dm-meta,.dm-conversation-header,.dm-turn-box-header,.dm-memory-card-head,.dm-dayline>*{min-width:0}
      .dm-muted,.dm-statusline,.dm-notice-line,.dm-ledger-list,.dm-meta,.dm-source code,.dm-conversation-header code,.dm-card,.dm-message,.dm-memory-bank article,.dm-formatted,.dm-warning{overflow-wrap:anywhere}
      .dm-content{scrollbar-gutter:stable;overscroll-behavior:contain}
      .dm-formatted table{max-width:100%;display:block;overflow-x:auto}
      .dm-ledger-list{list-style:none;margin:var(--dm-space-2) 0 var(--dm-space-4);padding:0;display:flex;flex-direction:column;gap:6px;font-size:12px}

      /* ---- states: status line, loading skeleton, notice and error ---- */
      .dm-statusline{display:flex;align-items:center;gap:6px;margin:0 0 var(--dm-space-2);color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
      .dm-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-tertiary)}
      .dm-statusline[data-status="ok"] .dm-dot{background:var(--dsw-alias-state-success-secondary)}
      .dm-statusline[data-status="offline"] .dm-dot{background:var(--dsw-alias-state-warn-primary)}
      .dm-statusline[data-status="probing"] .dm-dot{background:var(--dsw-alias-state-business-primary)}
      .dm-notice-line{margin:0 0 var(--dm-space-2);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
      .dm-loading{display:flex;flex-direction:column;gap:var(--dm-space-2);padding:var(--dm-space-4) 0}
      .dm-loading-text{margin:0}
      .dm-skeleton{height:12px;width:min(560px,100%);border-radius:999px;background:var(--dsw-alias-bg-layer-2);animation:dm-pulse 1.6s ease-in-out infinite}
      .dm-skeleton-short{width:min(320px,60%)}
      .dm-error{padding:var(--dm-space-3) var(--dm-space-4);border-radius:var(--dm-r-sm);background:var(--dsw-alias-bg-layer-1)}
      .dm-error p{margin:var(--dm-space-1) 0 0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
      .dm-empty{padding:clamp(40px,10vh,80px) var(--dm-space-4)}
      @keyframes dm-pulse{0%,100%{opacity:.55}50%{opacity:1}}
      @media (prefers-reduced-motion:reduce){.dm-skeleton{animation:none}}
      @media(max-width:720px){.dm-page{padding:0 var(--dm-space-4)}.dm-header{padding:var(--dm-space-5) 0 var(--dm-space-4)}.dm-card,.dm-message,.dm-turn-box,.dm-memory-bank article{padding:var(--dm-space-3)}.dm-content{padding-bottom:var(--dm-space-5)}}

      /* ---- dark developer console: tokens first, then component overrides ---- */
      .dm-page{--dm-bg:#0b1220;--dm-bg-soft:#0f1a2b;--dm-panel:#111c2e;--dm-panel-2:#16233a;--dm-border:#1f2f4a;--dm-border-strong:#2b3f61;--dm-text:#e6edf7;--dm-text-dim:#a9bbd4;--dm-text-mute:#7d90ad;--dm-accent:#4f8cff;--dm-accent-text:#ffffff;--dm-ok:#35c07a;--dm-warn:#f0b429;--dm-danger:#ff5d5d;--dm-purple:#a07bff;background:var(--dm-bg);color:var(--dm-text)}
      .dm-title{color:var(--dm-text)}.dm-intro,.dm-muted,.dm-open,.dm-source,.dm-version{color:var(--dm-text-dim)}
      .dm-dayline{border-bottom-color:var(--dm-border)}.dm-timeline:before{background:var(--dm-border)}
      .dm-marker{border-color:var(--dm-bg)}
      .dm-refresh{background:var(--dm-panel-2);border-color:var(--dm-border-strong);color:var(--dm-text)}
      .dm-refresh:hover:not(:disabled){background:#1d2d49;border-color:#3a5a8f}
      .dm-primary{background:var(--dm-accent);border-color:var(--dm-accent);color:var(--dm-accent-text);font-weight:600}
      .dm-primary:hover:not(:disabled){filter:brightness(1.08);background:var(--dm-accent)}
      .dm-quiet{color:var(--dm-text-dim);background:var(--dm-bg-soft)}
      .dm-back{color:var(--dm-text-dim)}.dm-back:hover{background:var(--dm-panel-2);color:var(--dm-text)}
      .dm-card,.dm-message,.dm-turn-box,.dm-memory-bank article,.dm-tools li,.dm-history-item,.dm-review-card section{background:var(--dm-panel);border-color:var(--dm-border)}
      .dm-card:hover{background:var(--dm-panel-2);border-color:var(--dm-border-strong)}
      .dm-message-you{border-left-color:var(--dm-accent)}.dm-message-assistant{border-left-color:var(--dm-ok)}.dm-message-tool{border-left-color:var(--dm-warn)}
      .dm-status-completed{color:var(--dm-ok)}.dm-status-closed_incomplete{color:var(--dm-warn)}
      .dm-statusline{color:var(--dm-text-mute)}.dm-dot{background:var(--dm-text-mute)}
      .dm-statusline[data-status="ok"] .dm-dot{background:var(--dm-ok)}
      .dm-statusline[data-status="offline"] .dm-dot{background:var(--dm-warn)}
      .dm-statusline[data-status="probing"] .dm-dot{background:var(--dm-accent)}
      .dm-skeleton{background:var(--dm-panel-2)}
      .dm-error{background:var(--dm-panel);border-color:#5b2b33;color:var(--dm-danger)}
      .dm-error p{color:var(--dm-text-dim)}
      .dm-input,.dm-textarea,.dm-merge select{background:var(--dm-bg-soft);border:1px solid var(--dm-border-strong);color:var(--dm-text);border-radius:8px;min-height:30px;padding:6px 10px;font:inherit;font-size:13px;box-sizing:border-box}
      .dm-input:focus-visible,.dm-textarea:focus-visible,.dm-merge select:focus-visible{outline:2px solid var(--dm-accent);outline-offset:1px}
      .dm-toolbar{display:flex;align-items:flex-end;gap:12px;flex-wrap:wrap;margin:12px 0 16px;padding:12px 14px;border:1px solid var(--dm-border);border-radius:12px;background:var(--dm-bg-soft)}
      .dm-field{display:flex;flex-direction:column;gap:4px;min-width:0}
      .dm-field-label{font-size:11px;line-height:16px;color:var(--dm-text-mute)}
      .dm-field .dm-input{width:min(280px,70vw)}
      .dm-field select.dm-input{width:auto;min-width:120px}
      .dm-filter-empty{padding:24px 0}
      .dm-evidence{margin-top:8px}
      .dm-evidence-located{margin:10px 0 0}
      .dm-message-hit{outline:2px solid var(--dm-accent);outline-offset:2px}
      .dm-host-queue{margin:20px 0 0;padding:14px 16px;border:1px solid var(--dm-border);border-radius:12px;background:var(--dm-bg-soft)}
      .dm-host-queue-list{list-style:none;margin:10px 0 0;padding:0;display:flex;flex-direction:column;gap:8px}
      .dm-host-queue-row{display:flex;flex-wrap:wrap;gap:8px 10px;align-items:baseline;padding:8px 0;border-bottom:1px solid var(--dm-border)}
      .dm-host-queue-actions{display:flex;gap:10px;align-items:center;margin-left:auto}
      .dm-changes{margin:20px 0 0;padding:14px 16px;border:1px solid var(--dm-border);border-radius:12px;background:var(--dm-bg-soft)}
      .dm-changes-list{list-style:none;margin:10px 0 0;padding:0;display:flex;flex-direction:column;gap:6px}
      .dm-changes-row{display:flex;flex-wrap:wrap;gap:8px 10px;align-items:baseline;padding:6px 0;border-bottom:1px solid var(--dm-border)}
      .dm-changes-time{margin-left:auto}
      .dm-changes-commit{font-family:var(--dm-mono)}
.dm-change-diff{flex-basis:100%;font-size:12px;overflow-wrap:anywhere}
      .dm-history{flex:1 1 100%;margin-top:10px;padding:10px 12px;border:1px solid var(--dm-border);border-radius:10px;background:var(--dm-bg-soft)}
      .dm-history-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px}
      .dm-history-item{padding-bottom:8px;border-bottom:1px solid var(--dm-border)}
      .dm-history-item:last-child{border-bottom:none;padding-bottom:0}
      .dm-history-head{font-weight:600}
      .dm-diff{margin:6px 0 0;padding:8px 10px;border-radius:8px;background:var(--dm-bg);overflow-x:auto;font-size:12px;line-height:1.6}
      .dm-diff-add{color:#7ee2a8;display:block}
      .dm-diff-del{color:#ff9d9d;display:block}
      .dm-diff-same{color:var(--dm-muted-fg);display:block}
      .dm-ledger-row{flex-wrap:wrap}
      .dm-ledger-line{display:flex;gap:10px;align-items:baseline;min-width:0;flex:1 1 auto}
      .dm-ledger-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-left:auto}
      .dm-ledger-edit{flex:1 1 100%;margin-top:8px}
      .dm-link.dm-danger{color:var(--dm-danger)}
      .dm-ledger-list li .dm-link{margin-left:auto}
      .dm-type{display:inline-block;margin-right:10px;padding:1px 8px;border-radius:999px;border:1px solid var(--dm-border-strong);font-size:11px;color:var(--dm-text-dim);white-space:nowrap}
      .dm-type-constraint{color:var(--dm-purple);border-color:#3b2f66;background:#1a1430}
      .dm-ledger-list li{display:flex;align-items:baseline;gap:4px;padding:6px 0;border-bottom:1px solid var(--dm-border)}
      .dm-trace{margin:20px 0 0;padding:14px 16px;border:1px solid var(--dm-border);border-radius:12px;background:var(--dm-bg-soft)}
      .dm-trace>summary{cursor:pointer;font-size:15px;font-weight:600;line-height:24px;color:var(--dm-text)}
      .dm-trace-hint{margin:6px 0 0;font-size:12px;color:var(--dm-text-mute)}
      .dm-trace-actions{display:flex;justify-content:flex-end;margin-top:10px}
      .dm-trace-list{list-style:none;margin:14px 0 0;padding:0;display:flex;flex-direction:column;gap:10px}
      .dm-trace-row{padding:12px 14px;border:1px solid var(--dm-border);border-radius:10px;background:var(--dm-panel)}
      .dm-trace-head{display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px}
      .dm-trace-turn{font-size:13px;font-weight:600;font-variant-numeric:tabular-nums;color:var(--dm-text)}
      .dm-trace-meta{font-size:12px;color:var(--dm-text-mute)}
      .dm-badges{display:flex;flex-wrap:wrap;gap:6px;margin-left:auto}
      .dm-badge{padding:1px 8px;border-radius:999px;font-size:11px;line-height:18px;border:1px solid var(--dm-border-strong);color:var(--dm-text-dim)}
      .dm-badge-info{color:#9dc0ff;border-color:#2b4a7d;background:#16294a}
      .dm-badge-ok{color:#8fe3b4;border-color:#1f5c3c;background:#13251c}
      .dm-badge-pending{color:#f3cf87;border-color:#5c4a1f;background:#241d10}
.dm-badge-bad{color:#f3a1a1;border-color:#5c2323;background:#2a1414}
      .dm-badge-muted{color:var(--dm-text-mute)}
      .dm-trace-fields{display:grid;grid-template-columns:120px 1fr;gap:6px 14px;margin:10px 0 0;font-size:12px;line-height:18px}
      .dm-trace-fields dt{color:var(--dm-text-mute)}
      .dm-trace-fields dd{margin:0;color:var(--dm-text-dim);overflow-wrap:anywhere}
      @media(max-width:720px){.dm-trace-fields{grid-template-columns:1fr;gap:2px}.dm-trace-fields dt{margin-top:6px}.dm-badges{margin-left:0}}
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
      changeView,
      correctionLabel,
      candidateStatusLabel,
      proposalActionLabel,
      proposalView,
      decisionLabel,
      policyLabel,
      originLabel,
      sourceKindLabel,
      diffLines,
      versionView,
      hostCandidateView,
      ledgerView,
      filterMemories,
      memoryTypes,
      injectionBadges,
      injectionRows,
      injectionView,
      evidenceRefsOf,
      locateTurnForEvent,
      evidenceTurn,
      ledgerEvidenceButton,
      messageClass,
      loadInjections,
      candidateErrorKey,
      candidateSubmitDisabled,
      textSubmitDisabled,
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
