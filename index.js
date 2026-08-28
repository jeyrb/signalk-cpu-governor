const fs = require('fs')
const path = require('path')

const CPU_BASE = '/sys/devices/system/cpu'
const CPUINFO_PATH = '/proc/cpuinfo'

const ARM_IMPLEMENTERS = {
  '0x41': 'ARM',
  '0x42': 'Broadcom',
  '0x43': 'Cavium',
  '0x48': 'HiSilicon',
  '0x4e': 'Nvidia',
  '0x50': 'APM',
  '0x51': 'Qualcomm',
  '0x53': 'Samsung',
  '0x56': 'Marvell',
  '0x61': 'Apple',
  '0x69': 'Intel'
}

// ARM implementer (0x41) core part numbers
const ARM_PARTS = {
  '0xd03': 'Cortex-A53',
  '0xd04': 'Cortex-A35',
  '0xd05': 'Cortex-A55',
  '0xd07': 'Cortex-A57',
  '0xd08': 'Cortex-A72',
  '0xd09': 'Cortex-A73',
  '0xd0a': 'Cortex-A75',
  '0xd0b': 'Cortex-A76',
  '0xd0c': 'Neoverse-N1',
  '0xd0d': 'Cortex-A77',
  '0xd41': 'Cortex-A78',
  '0xd44': 'Cortex-X1',
  '0xd46': 'Cortex-A510',
  '0xd47': 'Cortex-A710',
  '0xd48': 'Cortex-X2'
}

function cpuPartName (implementer, part) {
  if (implementer === '0x41' && ARM_PARTS[part]) return ARM_PARTS[part]
  const implName = ARM_IMPLEMENTERS[implementer]
  if (implName) return `${implName} part ${part}`
  return part
}

// RISC-V mvendorid/marchid identify a core the same way ARM's implementer/part
// do, but there's no widely-published lookup table for them and getting a hex
// code wrong here would just silently mislabel a board, so this seed is
// intentionally sparse. Send a PR with `cat /proc/cpuinfo` output from your
// board to add an entry — until then, cores group correctly, just displayed
// with the raw hex.
const RISCV_VENDOR_ARCH_NAMES = {
  // '0x489:0x8000000000000007': 'SiFive U74'
}

function riscvName (mvendorid, marchid, isa) {
  if (mvendorid && marchid) {
    const key = `${mvendorid}:${marchid}`
    if (RISCV_VENDOR_ARCH_NAMES[key]) return RISCV_VENDOR_ARCH_NAMES[key]
    return `RISC-V vendor ${mvendorid} arch ${marchid}`
  }
  if (isa) return `RISC-V (${isa})`
  return 'RISC-V'
}

function parseCpuList (str) {
  const ids = new Set()
  for (const part of String(str).trim().split(',')) {
    if (!part) continue
    if (part.includes('-')) {
      const [a, b] = part.split('-').map(Number)
      for (let i = a; i <= b; i++) ids.add(i)
    } else {
      ids.add(Number(part))
    }
  }
  return ids
}

// Intel hybrid (P-core/E-core) designs report the same "model name" for every
// core in /proc/cpuinfo, so grouping by model alone can't tell them apart.
// The kernel exposes the real split via these sysfs cpumasks instead.
function detectIntelHybridCoreTypes () {
  const types = new Map()
  const sources = [
    ['/sys/devices/cpu_core/cpus', 'P-core'],
    ['/sys/devices/cpu_atom/cpus', 'E-core']
  ]
  for (const [file, label] of sources) {
    try {
      if (!fs.existsSync(file)) continue
      for (const id of parseCpuList(fs.readFileSync(file, 'utf8'))) {
        types.set(id, label)
      }
    } catch (err) {
      // sysfs race or unreadable — ignore, hybrid split is best-effort
    }
  }
  return types
}

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

function detectCpuGroups () {
  let text
  try {
    text = fs.readFileSync(CPUINFO_PATH, 'utf8')
  } catch (err) {
    return fallbackSingleGroup()
  }

  // Parse line-by-line (not by blank-line blocks) since block spacing in
  // /proc/cpuinfo varies across kernels and a mis-split silently merges cores.
  const cores = []
  let current = null
  for (const line of text.split('\n')) {
    const processorMatch = line.match(/^processor\s*:\s*(\d+)/)
    if (processorMatch) {
      if (current) cores.push(current)
      current = {
        id: parseInt(processorMatch[1], 10),
        implementer: null,
        part: null,
        mvendorid: null,
        marchid: null,
        isa: null,
        model: null
      }
      continue
    }
    if (!current) continue

    const partMatch = line.match(/^CPU part\s*:\s*(0x[0-9a-fA-F]+)/)
    if (partMatch) {
      current.part = partMatch[1].toLowerCase()
      continue
    }
    const implMatch = line.match(/^CPU implementer\s*:\s*(0x[0-9a-fA-F]+)/)
    if (implMatch) {
      current.implementer = implMatch[1].toLowerCase()
      continue
    }
    // RISC-V core identification (mainline kernels expose these on newer
    // hardware; older ones only have "isa", handled below as a fallback).
    const mvendoridMatch = line.match(/^mvendorid\s*:\s*(0x[0-9a-fA-F]+)/)
    if (mvendoridMatch) {
      current.mvendorid = mvendoridMatch[1].toLowerCase()
      continue
    }
    const marchidMatch = line.match(/^marchid\s*:\s*(0x[0-9a-fA-F]+)/)
    if (marchidMatch) {
      current.marchid = marchidMatch[1].toLowerCase()
      continue
    }
    const isaMatch = line.match(/^isa\s*:\s*(.+)$/)
    if (isaMatch) {
      current.isa = isaMatch[1].trim()
      continue
    }
    // x86_64 and most other architectures report this per core.
    const modelMatch = line.match(/^model name\s*:\s*(.+)$/)
    if (modelMatch) {
      current.model = modelMatch[1].trim()
    }
  }
  if (current) cores.push(current)

  if (cores.length === 0) return fallbackSingleGroup()

  const hybridTypes = detectIntelHybridCoreTypes()

  const groups = new Map()
  for (const core of cores) {
    let key, name
    if (core.part) {
      const implementer = core.implementer || '0x41'
      key = `${implementer}:${core.part}`
      name = cpuPartName(implementer, core.part)
    } else if (core.mvendorid || core.marchid || core.isa) {
      key = core.mvendorid && core.marchid
        ? `riscv:${core.mvendorid}:${core.marchid}`
        : `riscv:${core.isa || 'unknown'}`
      name = riscvName(core.mvendorid, core.marchid, core.isa)
    } else if (core.model) {
      key = core.model
      name = core.model
    } else {
      key = 'unknown'
      name = 'unknown'
    }

    // Split hybrid designs (e.g. Intel P-core/E-core) that would otherwise
    // collapse into one group since every core reports the same identity.
    const hybridLabel = hybridTypes.get(core.id)
    if (hybridLabel) {
      key += `:${hybridLabel}`
      name = `${name} ${hybridLabel}`
    }

    if (!groups.has(key)) groups.set(key, { key, name, cores: [] })
    groups.get(key).cores.push(core.id)
  }

  return Array.from(groups.values()).map((g) => ({
    id: safeId(g.key),
    name: g.name,
    cores: g.cores.sort((a, b) => a - b)
  }))
}

function fallbackSingleGroup () {
  let ids
  try {
    ids = fs
      .readdirSync(CPU_BASE)
      .filter((name) => /^cpu\d+$/.test(name))
      .map((name) => parseInt(name.slice(3), 10))
  } catch (err) {
    ids = []
  }
  if (ids.length === 0) return []
  return [{ id: 'all', name: 'CPU', cores: ids.sort((a, b) => a - b) }]
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
    const groups = detectCpuGroups()

    const groupProperties = {}
    for (const group of groups) {
      groupProperties[group.id] = {
        type: 'object',
        title: `${group.cores.length}x ${group.name} (cores ${coreRangeLabel(group.cores)})`,
        properties: {
          ruleSet: {
            type: 'array',
            title: 'Rule names, in priority order (first match wins; if none match, the governor is left unchanged)',
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
          description:
            'CPU clusters detected on this device. Assign each an ordered list of rule names.',
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
    if (detectedGroups.length === 0) {
      app.error(`No cpufreq scaling_governor files found under ${CPU_BASE} — this board/kernel may not expose cpufreq.`)
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
      app.error(`No writable/detected cpufreq scaling_governor files found under ${CPU_BASE}.`)
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
