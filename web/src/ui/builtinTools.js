export function getBuiltinTools() {
  return [
    {
      type: 'function',
      function: {
        name: 'sleep',
        description: 'Call this tool if you need to wait for a process to end, estimate the desired wait time and enter it as seconds (integer).',
        parameters: {
          type: 'object',
          properties: {
            seconds: { type: 'integer', description: 'How long to wait in seconds.' },
          },
          required: ['seconds'],
        },
      },
    },
  ]
}

export function isBuiltinToolName(name) {
  return name === 'sleep'
}

export async function runBuiltinTool(name, args) {
  if (name === 'sleep') {
    const secondsRaw = args && (args.seconds ?? args.secs ?? args.time)
    const secondsNum = Number(secondsRaw)
    const seconds = Number.isFinite(secondsNum) ? Math.max(0, Math.floor(secondsNum)) : 0
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000))
    return { ok: true, waited_seconds: seconds }
  }
  return null
}


