export function makeFakeSession(items) {
  const bySeq = new Map();
  const nodes = [];
  for (const item of items) {
    const seq = Number(item.seq);
    let data;
    if (item.type === 'assistant/message') {
      data = {
        message: {
          role: 'assistant',
          content: [
            ...(item.reasoning ? [{ type: 'reasoning', text: item.reasoning }] : []),
            ...(item.text ? [{ type: 'text', text: item.text }] : [])
          ]
        }
      };
    } else {
      data = {
        role: 'user',
        source: item.source ?? { kind: 'user' },
        content: [{ type: 'text', text: item.text ?? '' }]
      };
    }
    const event = { seq, type: item.type, surfaceOp: 'append', data };
    bySeq.set(seq, event);
    nodes.push(seq);
  }
  return {
    id: 'fixture-session',
    surface: { nodes },
    eventAt: (seq) => bySeq.get(Number(seq)),
    deriveEventMessage: (event) => {
      if (event === undefined) return null;
      if (event.type === 'user/message') return event.data;
      return event.data?.message ?? null;
    },
    append: () => {
      throw new Error('append is not used in read-only tests');
    }
  };
}
