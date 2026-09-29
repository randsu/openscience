import type { Connector, ConnectorHit } from "../types"
import { getJSON, orNotFound } from "../http"
import { clampLimit, snippet } from "./util"

/**
 * BioSimulators — registry of simulation tools for systems-biology and
 * neuroscience models (SBML, CellML, NeuroML, BNGL, …), each described by the
 * KiSAO algorithms and model formats it supports. No key required.
 *   search: GET /simulators/latest                (every tool at its latest version)
 *   fetch:  GET /simulators/<id>/latest           or /simulators/<id>/<version>
 *
 * The registry has no query endpoint, so search filters the full list here; it
 * is about 600 KB and one cached request. This is the registry only: running a
 * simulation goes through api.biosimulations.org, which requires an account.
 */
const API = "https://api.biosimulators.org"
const SITE = "https://biosimulators.org"

// A record names its model formats by EDAM id alone, so without the names a
// search for "SBML" matches nothing. An id missing here is still searchable.
const FORMATS: Record<string, string> = {
  format_2332: "XML",
  format_2585: "SBML",
  format_3240: "CellML",
  format_3621: "SQLite format",
  format_3971: "NeuroML",
  format_3972: "BNGL",
  format_9000: "Virtual Cell Markup Language",
  format_9001: "Smoldyn simulation configuration language",
  format_9002: "Morpheus Markup Language",
  format_9004: "Low Entropy Model Specification",
  format_9005: "High Order Calculator",
  format_9006: "Kappa",
  format_9008: "GINsim Markup Language, Zipped",
  format_9010: "XPP",
  format_9012: "Resource Balance Analysis XML format",
}

interface Term {
  id?: string
}

interface Algorithm {
  id?: string
  name?: string
  kisaoId?: Term
  modelFormats?: Term[]
  modelingFrameworks?: Term[]
  simulationTypes?: string[]
}

interface Simulator {
  id?: string
  name?: string
  version?: string
  description?: string
  algorithms?: Algorithm[]
  interfaceTypes?: string[]
  image?: { url?: string } | null
  license?: Term | null
  [key: string]: unknown
}

const unique = (values: Array<string | undefined>) => [...new Set(values.filter((v): v is string => Boolean(v)))]

// The full record runs to 50 KB for the largest tools; a hit carries what is
// needed to choose one, and fetch returns the rest.
function brief(s: Simulator) {
  const algorithms = s.algorithms ?? []
  return {
    id: s.id,
    version: s.version,
    algorithms: algorithms.map((a) => ({ kisaoId: a.kisaoId?.id, name: a.name })),
    modelFormats: unique(algorithms.flatMap((a) => a.modelFormats ?? []).map((f) => f.id)).map((id) => ({
      id,
      name: FORMATS[id],
    })),
    modelingFrameworks: unique(algorithms.flatMap((a) => a.modelingFrameworks ?? []).map((f) => f.id)),
    simulationTypes: unique(algorithms.flatMap((a) => a.simulationTypes ?? [])),
    interfaceTypes: s.interfaceTypes,
    image: s.image?.url,
    license: s.license?.id,
  }
}

export const biosimulators: Connector = {
  id: "biosimulators",
  name: "BioSimulators",
  domain: "biology",
  description: "Registry of biological simulation tools with their algorithms and formats (SBML, CellML, NeuroML).",
  homepage: SITE,

  async search(query, opts) {
    const limit = clampLimit(opts?.limit, 10, 25)
    // KISAO:0000019 and KISAO_0000019 are the same term; the registry writes the latter.
    const terms = query.toLowerCase().replaceAll(":", "_").split(/\s+/).filter(Boolean)
    if (!terms.length) return []
    const data = await getJSON<Simulator[]>(`${API}/simulators/latest`, { signal: opts?.signal })
    if (!Array.isArray(data)) return []

    const hits: Array<ConnectorHit & { score: number }> = []
    for (const s of data) {
      if (!s.id) continue
      const about = brief(s)
      const label = `${s.id} ${s.name ?? ""}`.toLowerCase()
      const text = [
        label,
        s.description,
        ...about.algorithms.flatMap((a) => [a.kisaoId, a.name]),
        ...about.modelFormats.flatMap((f) => [f.id, f.name]),
        ...about.modelingFrameworks,
        ...about.simulationTypes,
      ]
        .join(" ")
        .toLowerCase()
      if (!terms.every((t) => text.includes(t))) continue
      const formats = about.modelFormats.map((f) => f.name ?? f.id).join(", ")
      hits.push({
        id: s.id,
        title: s.version ? `${s.name ?? s.id} ${s.version}` : (s.name ?? s.id),
        summary: snippet([formats && `Formats: ${formats}.`, s.description].filter(Boolean).join(" ")),
        url: `${SITE}/simulators/${encodeURIComponent(s.id)}`,
        // A tool named in the query outranks one that merely mentions it.
        score: terms.filter((t) => label.includes(t)).length / terms.length,
        extra: about,
      })
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit)
  },

  async fetch(id, opts) {
    const [tool, version] = id.trim().split(/[/@]/)
    if (!tool) return null
    const url = `${API}/simulators/${encodeURIComponent(tool)}/${encodeURIComponent(version || "latest")}`
    return orNotFound(getJSON<Simulator>(url, { signal: opts?.signal }), null)
  },
}
