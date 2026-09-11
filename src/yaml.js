/**
 * 极简 YAML 解析器 —— 只覆盖 Clash / mihomo 配置用到的子集，避免引入依赖：
 *   - 缩进块映射、块序列
 *   - 行内流式集合 [a, b] / {k: v}
 *   - 单双引号、数字、布尔、null、行内注释
 * 不支持锚点、多行标量、复杂 key，这些 Clash 订阅里不会出现。
 */

/** 去掉行内注释（引号内的 # 不算注释） */
function stripComment(line) {
  let q = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (q) {
      if (c === '\\') i++
      else if (c === q) q = null
    } else if (c === '"' || c === "'") {
      q = c
    } else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i)
    }
  }
  return line
}

function unquote(s) {
  if (s.length >= 2) {
    const a = s[0]
    if ((a === '"' || a === "'") && s[s.length - 1] === a) {
      const body = s.slice(1, -1)
      return a === '"' ? body.replace(/\\"/g, '"').replace(/\\\\/g, '\\').replace(/\\n/g, '\n') : body.replace(/''/g, "'")
    }
  }
  return s
}

/** 解析流式集合，返回 [值, 消耗的字符数] */
function parseFlow(s, i) {
  const start = i
  const open = s[i]
  const close = open === '[' ? ']' : '}'
  const isArr = open === '['
  const out = isArr ? [] : {}
  i++
  let key = null
  let buf = ''
  let q = null

  const flush = () => {
    const t = buf.trim()
    buf = ''
    if (!t && key === null) return
    if (isArr) out.push(parseScalar(t))
    else if (key !== null) {
      out[key] = parseScalar(t)
      key = null
    }
  }

  while (i < s.length) {
    const c = s[i]
    if (q) {
      buf += c
      if (c === '\\') {
        buf += s[++i] ?? ''
      } else if (c === q) q = null
      i++
      continue
    }
    if (c === '"' || c === "'") {
      q = c
      buf += c
      i++
      continue
    }
    if (c === '[' || c === '{') {
      const [v, used] = parseFlow(s, i)
      if (isArr) out.push(v)
      else if (key !== null) {
        out[key] = v
        key = null
      }
      buf = ''
      i += used
      continue
    }
    if (c === close) {
      flush()
      return [out, i + 1 - start]
    }
    if (c === ',') {
      flush()
      i++
      continue
    }
    if (c === ':' && !isArr && key === null) {
      key = unquote(buf.trim())
      buf = ''
      i++
      continue
    }
    buf += c
    i++
  }
  flush()
  return [out, i - start]
}

function parseScalar(raw) {
  const t = String(raw).trim()
  if (t === '' || t === '~' || t === 'null' || t === 'Null' || t === 'NULL') return null
  if (t === 'true' || t === 'True' || t === 'TRUE' || t === 'yes' || t === 'on') return true
  if (t === 'false' || t === 'False' || t === 'FALSE' || t === 'no' || t === 'off') return false
  if (t[0] === '[' || t[0] === '{') return parseFlow(t, 0)[0]
  if (/^-?\d+$/.test(t)) {
    const n = Number(t)
    return Number.isSafeInteger(n) ? n : t
  }
  if (/^-?\d*\.\d+$/.test(t)) return Number(t)
  return unquote(t)
}

/** 把 "key: value" 拆成 [key, valueText]；不是映射行返回 null */
function splitKey(text) {
  let q = null
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (q) {
      if (c === '\\') i++
      else if (c === q) q = null
      continue
    }
    if (c === '"' || c === "'") {
      q = c
      continue
    }
    // 流式集合里的冒号不是分隔符
    if (c === '[' || c === '{') {
      const [, used] = parseFlow(text, i)
      i += used - 1
      continue
    }
    if (c === ':' && (i + 1 >= text.length || /\s/.test(text[i + 1]))) {
      return [unquote(text.slice(0, i).trim()), text.slice(i + 1).trim()]
    }
  }
  return null
}

export function parseYaml(input) {
  const lines = []
  for (const rawLine of String(input).replace(/\r\n?/g, '\n').split('\n')) {
    const noComment = stripComment(rawLine)
    if (!noComment.trim()) continue
    if (/^\s*(---|\.\.\.)\s*$/.test(noComment)) continue
    const indent = noComment.length - noComment.trimStart().length
    lines.push({ indent, text: noComment.trim() })
  }

  let pos = 0

  function parseNode(indent) {
    if (pos >= lines.length) return null
    return lines[pos].text.startsWith('- ') || lines[pos].text === '-' ? parseSeq(indent) : parseMap(indent)
  }

  function parseSeq(indent) {
    const out = []
    while (pos < lines.length && lines[pos].indent === indent && (lines[pos].text.startsWith('- ') || lines[pos].text === '-')) {
      const line = lines[pos]
      const rest = line.text === '-' ? '' : line.text.slice(2).trim()
      pos++

      if (!rest) {
        // "-" 单独一行，值在下一层缩进
        out.push(pos < lines.length && lines[pos].indent > indent ? parseNode(lines[pos].indent) : null)
        continue
      }

      const kv = splitKey(rest)
      if (kv) {
        // "- key: value" —— 序列项是个映射，把 dash 后的内容当作该映射的首行。
        // 子键缩进 = dash 缩进 + dash 后内容的偏移，兼容 "-   key: v" 这种多空格写法。
        const m = /^-(\s*)/.exec(line.text)
        const childIndent = indent + 1 + (m ? m[1].length : 1)
        lines.splice(pos, 0, { indent: childIndent, text: rest })
        out.push(parseMap(childIndent))
      } else {
        out.push(parseScalar(rest))
      }
    }
    return out
  }

  function parseMap(indent) {
    const out = {}
    while (pos < lines.length && lines[pos].indent === indent) {
      const kv = splitKey(lines[pos].text)
      if (!kv) break
      const [key, valText] = kv
      pos++
      if (valText) {
        out[key] = parseScalar(valText)
      } else if (pos < lines.length && lines[pos].indent > indent) {
        out[key] = parseNode(lines[pos].indent)
      } else if (pos < lines.length && lines[pos].indent === indent && (lines[pos].text.startsWith('- ') || lines[pos].text === '-')) {
        // 序列与父键同缩进，YAML 允许
        out[key] = parseSeq(indent)
      } else {
        out[key] = null
      }
    }
    return out
  }

  if (!lines.length) return null
  return parseNode(lines[0].indent)
}
