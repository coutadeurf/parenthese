// Rendu SVG minimal d'un layout (même vocabulaire visuel que la galaxie : cercle, prénom, barre de couple, filiation)
import { writeFileSync } from 'node:fs'

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')

export function renderSvg(result, coupleBarMeta, file, title = '') {
  const nodes = result.children
  const byId = new Map(nodes.map(n => [n.id, n]))
  const pad = 60
  const minX = Math.min(...nodes.map(n => n.x)) - pad
  const minY = Math.min(...nodes.map(n => n.y)) - pad
  const maxX = Math.max(...nodes.map(n => n.x + n.width)) + pad
  const maxY = Math.max(...nodes.map(n => n.y + n.height)) + pad
  const W = maxX - minX, H = maxY - minY
  const out = []
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX} ${minY} ${W} ${H}" width="${W}" height="${H}" style="background:#FDF8EC;font-family:Georgia,serif">`)
  if (title) out.push(`<text x="${minX + 20}" y="${minY + 30}" font-size="22" fill="#5D524B">${esc(title)}</text>`)

  // Filiations
  for (const e of result.edges) {
    const s = byId.get(e.sources[0]); const t = byId.get(e.targets[0])
    if (!s || !t) continue
    const sx = s.x + s.width / 2, sy = s.y + s.height / 2
    const tx = t.x + t.width / 2, ty = t.y + t.height / 2 - 30
    const dy = ty - sy, dx = tx - sx
    // Renvoi : pastilles dans l'app, pointillé ici — pas de trait continu
    if (e._renvoi) {
      out.push(`<line x1="${sx}" y1="${sy}" x2="${sx}" y2="${sy + 40}" fill="none" stroke="#5D524B" stroke-opacity="0.25" stroke-width="1.2" stroke-dasharray="3,4"/>`)
      out.push(`<line x1="${tx}" y1="${ty - 40}" x2="${tx}" y2="${ty}" fill="none" stroke="#5D524B" stroke-opacity="0.25" stroke-width="1.2" stroke-dasharray="3,4"/>`)
      continue
    }
    // Couloir (layout « rooted ») : connecteur orthogonal entre les deux rangées
    if (e._corridor) {
      const busY = (s.y + s.height + t.y) / 2
      out.push(`<path d="M${sx},${s.y + s.height} L${sx},${busY} L${tx},${busY} L${tx},${t.y}" fill="none" stroke="#5D524B" stroke-opacity="0.45" stroke-width="1.2"/>`)
      continue
    }
    out.push(`<path d="M${sx},${sy} C${sx + dx * 0.3},${sy + dy * 0.5} ${tx - dx * 0.3},${ty - dy * 0.5} ${tx},${ty}" fill="none" stroke="#5D524B" stroke-opacity="0.45" stroke-width="1.2"/>`)
  }
  // Couples
  for (const c of coupleBarMeta) {
    const p1 = byId.get(c.p1Key); const p2 = byId.get(c.p2Key)
    if (!p1 || !p2) continue
    const y = p1.y + p1.height / 2
    out.push(`<line x1="${p1.x + p1.width / 2}" y1="${y}" x2="${p2.x + p2.width / 2}" y2="${p2.y + p2.height / 2}" stroke="#A67C52" stroke-width="2"/>`)
  }
  // Noeuds
  for (const n of nodes) {
    const cx = n.x + n.width / 2, cy = n.y + n.height / 2
    if (n._type === 'person') {
      const p = n._data
      const fill = p.isAlive === false ? '#E8DCC8' : '#F7ECD9'
      out.push(`<circle cx="${cx}" cy="${cy - 10}" r="26" fill="${fill}" stroke="#A67C52" stroke-width="1.5"/>`)
      out.push(`<text x="${cx}" y="${cy + 34}" font-size="11" text-anchor="middle" fill="#5D524B">${esc((p.firstName || '').slice(0, 14))}</text>`)
      out.push(`<text x="${cx}" y="${cy + 46}" font-size="9" text-anchor="middle" fill="#8B7355">${esc(p.birthYear ?? '')}</text>`)
    } else if (n._type === 'union') {
      out.push(`<circle cx="${cx}" cy="${cy}" r="3" fill="#A67C52"/>`)
    } else if (n._type === 'unknown') {
      out.push(`<circle cx="${cx}" cy="${cy - 10}" r="16" fill="#E8E2DC" stroke="#A89F97" stroke-dasharray="3 2"/>`)
      out.push(`<text x="${cx}" y="${cy - 6}" font-size="12" text-anchor="middle" fill="#A89F97">?</text>`)
    }
  }
  out.push('</svg>')
  writeFileSync(file, out.join('\n'))
  return { W, H }
}
