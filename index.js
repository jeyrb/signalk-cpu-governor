const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const CPU_BASE = '/sys/devices/system/cpu'

function safeId (key) {
  return key.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'cpu'
}

function coreRangeLabel (ids) {
  const sorted = [...ids].sort((a, b) => a - b)
  const ranges = []
  let start = sorted[0]
  let prev = sorted[0]
  for (let i = 1; i <= sorted.length; i++) {
    const cur = sorted[i]
    if (cur === prev + 1) {
      prev = cur
      continue
    }
    ranges.push(start === prev ? `${start}` : `${start}-${prev}`)
    start = cur
    prev = cur
  }
  return ranges.join(',')
}

// `lscpu` (util-linux) already ships (and maintains) its own vendor/model
// name tables for every architecture, so we don't hand-roll one. lscpu -J
// lists each detected CPU model as a flat "Model name:" entry, each followed
// by its own "Core(s) per socket:" / "Socket(s):" / "Thread(s) per core:" —
// enough to say how many cores of that model exist, which is all a governor
// policy needs (it's applied per model type / per whole CPU, not per
// individual core). Exactly which logical core ids those are doesn't need to
// be pinned down independently: the kernel always enumerates a cluster's
// cores contiguously in discovery order, so the Nth model block simply
// claims the next `count` ids — the same order lscpu itself walked to
// produce these blocks.
//
// Returns null if lscpu isn't installed or its output can't be trusted (the
// counts don't add up to the board's total CPU count) — the plugin disables
// itself in that case rather than guess at CPU topology.
function detectCpuGroups () {
  let fields
  try {
    const summary = JSON.parse(execFileSync('lscpu', ['-J'], { encoding: 'utf8' }))
    fields = []
    const collect = (nodes) => {
      for (const n of nodes || []) {
        fields.push(n)
        if (n.children) collect(n.children)
      }
    }
    collect(summary.lscpu)
  } catch (err) {
    return null
  }

  let totalCpus = null
  const blocks = []
  let block = null
  for (const f of fields) {
    const key = String(f.field || '').replace(/:$/, '').trim()
    if (!block && key === 'CPU(s)') {
      totalCpus = parseInt(f.data, 10)
      continue
    }
    if (key === 'Model name') {
      block = { name: f.data, coresPerSocket: null, sockets: 1, threadsPerCore: 1 }
      blocks.push(block)
      continue
    }
    if (!block) continue
    if (key === 'Core(s) per socket') block.coresPerSocket = parseInt(f.data, 10)
    else if (key === 'Socket(s)') block.sockets = parseInt(f.data, 10)
    else if (key === 'Thread(s) per core') block.threadsPerCore = parseInt(f.data, 10)
  }
  if (blocks.length === 0 || totalCpus === null) return null

  const counted = blocks.map((b) => ({
    name: b.name,
    count: (b.coresPerSocket || 0) * (b.sockets || 1) * (b.threadsPerCore || 1)
  }))
  if (counted.some((b) => !b.count)) return null
  if (counted.reduce((n, b) => n + b.count, 0) !== totalCpus) return null

  let nextId = 0
  return counted.map((b) => {
    const cores = []
    for (let i = 0; i < b.count; i++) cores.push(nextId++)
    return { id: safeId(`${b.name}_${cores[0]}_${cores[cores.length - 1]}`), name: b.name, cores }
  })
}

function groupGovernorFiles (group) {
  return group.cores
    .map((id) => path.join(CPU_BASE, `cpu${id}`, 'cpufreq', 'scaling_governor'))
    .filter((p) => fs.existsSync(p))
}

function compare (value, comparator, threshold) {
  switch (comparator) {
    case '<=':
      return value <= threshold
    case '<':
      return value < threshold
    case '>=':
      return value >= threshold
    case '>':
      return value > threshold
    case '==':
      return value === threshold
    default:
      return false
  }
}

function ruleMatches (rule, app) {
  let reading
  try {
    reading = app.getSelfPath(rule.path)
  } catch (err) {
    return false
  }
  if (!reading || reading.value === undefined || reading.value === null) return false

  if (rule.matchType === 'enum') {
    return String(reading.value) === String(rule.enumValue)
  }

  if (typeof reading.value !== 'number') return false
  return compare(reading.value, rule.comparator || '<=', rule.value)
}

module.exports = function (app) {
  const plugin = {
    id: 'signalk-cpu-governor',
    name: 'CPU Governor Switcher',
    description:
      'Tunes CPU speeds based on rules matched against SignalK data paths.'
  }

  let timer

  plugin.schema = () => {
    const groups = detectCpuGroups() || []

    const groupProperties = {}
    for (const group of groups) {
      // The SignalK admin form doesn't render a nested object's own "title"
      // as a section header, so the CPU cluster's identity has to live on
      // the one visible leaf field (ruleSet) instead, or groups become
      // indistinguishable in the UI.
      const groupLabel = `${group.cores.length}x ${group.name} (cores ${coreRangeLabel(group.cores)})`
      groupProperties[group.id] = {
        type: 'object',
        title: groupLabel,
        properties: {
          ruleSet: {
            type: 'array',
            title: `${groupLabel} — rule names, in priority order (first match wins; if none match, the governor is left unchanged)`,
            items: { type: 'string' },
            default: []
          }
        }
      }
    }

    return {
      type: 'object',
      properties: {
        pollIntervalSeconds: {
          type: 'number',
          title: 'How often to evaluate rules, in seconds',
          default: 30
        },
        rules: {
          type: 'array',
          title: 'Rules',
          description:
            'Each rule watches a SignalK path and names a governor to apply when it matches. Reference rules by name (case-sensitive) from the CPU groups below.',
          items: {
            type: 'object',
            required: ['name', 'path', 'governor'],
            properties: {
              name: {
                type: 'string',
                title: 'Rule name (referenced from CPU groups below)'
              },
              path: {
                type: 'string',
                title: 'SignalK path to watch'
              },
              matchType: {
                type: 'string',
                title: 'Match type',
                enum: ['threshold', 'enum'],
                default: 'threshold'
              },
              comparator: {
                type: 'string',
                title: 'Comparator (threshold match only)',
                enum: ['<=', '<', '>=', '>', '=='],
                default: '<='
              },
              value: {
                type: 'number',
                title: 'Threshold value (threshold match only)'
              },
              enumValue: {
                type: 'string',
                title: 'Value to match, as a string (enum match only)'
              },
              governor: {
                type: 'string',
                title: 'Governor to apply when this rule matches'
              }
            }
          },
          default: []
        },
        groups: {
          type: 'object',
          title: 'CPU groups',
          description: groups.length === 0
            ? 'No CPU clusters detected — is `lscpu` (util-linux) installed? See README.'
            : 'CPU clusters detected on this device. Assign each an ordered list of rule names.',
          properties: groupProperties
        }
      }
    }
  }

  plugin.start = (options) => {
    const opts = {
      pollIntervalSeconds: Math.max(5, options.pollIntervalSeconds || 30),
      rules: Array.isArray(options.rules) ? options.rules : [],
      groups: options.groups || {}
    }

    const detectedGroups = detectCpuGroups()
    if (!detectedGroups) {
      app.error(
        '`lscpu` (util-linux) was not found, or its output could not be parsed — this plugin requires it ' +
          'to detect CPU clusters. Install util-linux (e.g. `apk add util-linux` on Alpine) and restart ' +
          'SignalK. Plugin disabled.'
      )
      app.setPluginStatus('Disabled: lscpu not available')
      return
    }

    const ruleByName = new Map()
    for (const rule of opts.rules) {
      if (!rule || !rule.name) continue
      ruleByName.set(rule.name, rule)
    }

    const runtimeGroups = detectedGroups
      .map((group) => {
        const files = groupGovernorFiles(group)
        if (files.length === 0) return null
        const config = opts.groups[group.id] || {}
        const ruleSet = Array.isArray(config.ruleSet) ? config.ruleSet : []
        return { ...group, files, ruleSet, currentGovernor: null }
      })
      .filter(Boolean)

    if (runtimeGroups.length === 0) {
      app.error(`No cpufreq scaling_governor files found under ${CPU_BASE} — this board/kernel may not expose cpufreq. Plugin disabled.`)
      app.setPluginStatus('Disabled: no cpufreq scaling_governor files found')
      return
    }

    const applyGovernor = (group, governor) => {
      if (governor === group.currentGovernor) return
      try {
        for (const file of group.files) {
          fs.writeFileSync(file, governor)
        }
        group.currentGovernor = governor
      } catch (err) {
        app.error(
          `Failed to set governor "${governor}" for group "${group.name}" via ${group.files[0]}: ${err.message}. ` +
            'The SignalK process likely lacks write permission — see README for the udev rule to fix this.'
        )
      }
    }

    const check = () => {
      for (const group of runtimeGroups) {
        for (const ruleName of group.ruleSet) {
          const rule = ruleByName.get(ruleName)
          if (!rule) {
            app.debug(`Group "${group.name}" references unknown rule "${ruleName}"`)
            continue
          }
          if (ruleMatches(rule, app)) {
            applyGovernor(group, rule.governor)
            break
          }
        }
      }

      const status = runtimeGroups
        .map((g) => `${g.name}: ${g.currentGovernor || 'unchanged'}`)
        .join(' | ')
      app.setPluginStatus(status)
    }

    check()
    timer = setInterval(check, opts.pollIntervalSeconds * 1000)
  }

  plugin.stop = () => {
    if (timer) {
      clearInterval(timer)
      timer = undefined
    }
  }

  return plugin
}
