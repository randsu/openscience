import { beforeEach, describe, expect, test } from "bun:test"
import { registry } from "../../src/science/connectors"
import { biosimulators } from "../../src/science/connectors/pathways/biosimulators"
import { clearCache, withHttpTestPolicy } from "../../src/science/connectors/http"

// Six records from GET https://api.biosimulators.org/simulators/latest, retrieved
// 2026-10-02 and reduced to the fields the connector reads. The live list holds 54.
const latest = await Bun.file(new URL("fixtures/biosimulators-latest.json", import.meta.url)).text()
// The recorder's fetch fixture: tellurium 2.2.10 as GET /simulators/tellurium/latest returned it.
const recorded = await Bun.file(new URL("fixtures/fetch/biosimulators.json", import.meta.url)).json()
const resolveAddresses = async () => ["93.184.216.34"]
beforeEach(clearCache)

function registryOf(requests: string[] = []) {
  return {
    resolveAddresses,
    transport: async (url: URL) => {
      requests.push(url.pathname)
      if (url.pathname === "/simulators/latest") return new Response(latest)
      if (url.pathname === "/simulators/tellurium/latest") return Response.json(recorded.payload)
      if (url.pathname === "/simulators/tellurium/2.2.8")
        return Response.json({ ...recorded.payload, version: "2.2.8" })
      const tool = url.pathname.split("/")[2]
      return Response.json(
        { error: [{ status: "404", title: "Not Found", detail: `"No simulation tool has id '${tool}'."` }] },
        { status: 404 },
      )
    },
  }
}

const ids = (hits: Array<{ id: string }>) => hits.map((hit) => hit.id)

describe("biosimulators search", () => {
  test("finds a simulator by name and describes it", async () => {
    const requests: string[] = []
    await withHttpTestPolicy(registryOf(requests), async () => {
      const hits = await biosimulators.search("COPASI")
      expect(ids(hits)).toEqual(["copasi"])
      expect(hits[0]).toMatchObject({
        title: "COPASI 4.45.296",
        url: "https://biosimulators.org/simulators/copasi",
        extra: { id: "copasi", version: "4.45.296", modelFormats: [{ id: "format_2585", name: "SBML" }] },
      })
      expect(hits[0]!.summary).toStartWith("Formats: SBML.")
    })
    expect(requests).toEqual(["/simulators/latest"])
  })

  test("a simulator named in the query outranks one that mentions it", async () => {
    await withHttpTestPolicy(registryOf(), async () => {
      // NetPyNE's description names NEURON, the simulator it drives.
      expect(ids(await biosimulators.search("neuron"))).toEqual(["neuron", "netpyne"])
    })
  })

  test("finds simulators by KiSAO id in either spelling and by algorithm name", async () => {
    await withHttpTestPolicy(registryOf(), async () => {
      const cvode = ["tellurium", "neuron", "bionetgen", "netpyne"]
      expect(ids(await biosimulators.search("KISAO_0000019"))).toEqual(cvode)
      expect(ids(await biosimulators.search("KISAO:0000019"))).toEqual(cvode)
      expect(ids(await biosimulators.search("kisao:0000437"))).toEqual(["cobrapy"])
      expect(ids(await biosimulators.search("flux balance analysis"))).toEqual(["cobrapy"])
    })
  })

  test("finds simulators by model format name and by EDAM id", async () => {
    await withHttpTestPolicy(registryOf(), async () => {
      expect(ids(await biosimulators.search("SBML"))).toEqual(["tellurium", "copasi", "cobrapy"])
      expect(ids(await biosimulators.search("NeuroML"))).toEqual(["neuron", "netpyne"])
      expect(ids(await biosimulators.search("BNGL"))).toEqual(["bionetgen"])
      expect(ids(await biosimulators.search("format_3971"))).toEqual(["neuron", "netpyne"])
    })
  })

  test("every term has to match", async () => {
    await withHttpTestPolicy(registryOf(), async () => {
      expect(ids(await biosimulators.search("sbml flux"))).toEqual(["cobrapy"])
      expect(await biosimulators.search("sbml neuroml")).toEqual([])
      expect(await biosimulators.search("not-a-simulator")).toEqual([])
    })
  })

  test("honors the limit and keeps it within bounds", async () => {
    await withHttpTestPolicy(registryOf(), async () => {
      expect(ids(await biosimulators.search("python", { limit: 2 }))).toHaveLength(2)
      expect(await biosimulators.search("SBML", { limit: 1 })).toHaveLength(1)
      expect(await biosimulators.search("SBML", { limit: 0 })).toHaveLength(1)
      expect(await biosimulators.search("SBML", { limit: 1000 })).toHaveLength(3)
    })
  })

  test("an empty query asks the registry nothing", async () => {
    const requests: string[] = []
    await withHttpTestPolicy(registryOf(requests), async () => {
      expect(await biosimulators.search("   ")).toEqual([])
    })
    expect(requests).toEqual([])
  })

  test("repeated searches read the registry list once", async () => {
    const requests: string[] = []
    await withHttpTestPolicy(registryOf(requests), async () => {
      await biosimulators.search("SBML")
      await biosimulators.search("NeuroML")
    })
    expect(requests).toEqual(["/simulators/latest"])
  })

  test("a cancelled search rejects instead of returning hits", async () => {
    const started = Promise.withResolvers<void>()
    const abort = new AbortController()
    await withHttpTestPolicy(
      {
        resolveAddresses,
        transport: async (_url, options) => {
          started.resolve()
          const signal = options?.signal
          return new Promise<Response>((_resolve, reject) =>
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true }),
          )
        },
      },
      async () => {
        const search = biosimulators.search("SBML", { signal: abort.signal })
        await started.promise
        abort.abort()
        await expect(search).rejects.toBeInstanceOf(DOMException)
      },
    )
  })
})

describe("biosimulators fetch", () => {
  test("returns the latest record for a bare id", async () => {
    const requests: string[] = []
    await withHttpTestPolicy(registryOf(requests), async () => {
      const record = await biosimulators.fetch("tellurium")
      expect(record).toEqual(recorded.payload)
      expect(record).toMatchObject({ id: "tellurium", version: "2.2.10" })
    })
    expect(requests).toEqual(["/simulators/tellurium/latest"])
  })

  test("returns the named version for id/version and id@version", async () => {
    const requests: string[] = []
    await withHttpTestPolicy(registryOf(requests), async () => {
      expect(await biosimulators.fetch("tellurium/2.2.8")).toMatchObject({ id: "tellurium", version: "2.2.8" })
      clearCache()
      expect(await biosimulators.fetch(" tellurium@2.2.8 ")).toMatchObject({ id: "tellurium", version: "2.2.8" })
    })
    expect(requests).toEqual(["/simulators/tellurium/2.2.8", "/simulators/tellurium/2.2.8"])
  })

  test("an unknown simulator or version is a miss, not an error", async () => {
    await withHttpTestPolicy(registryOf(), async () => {
      expect(await biosimulators.fetch("not-a-simulator")).toBeNull()
      expect(await biosimulators.fetch("tellurium/0.0.0")).toBeNull()
    })
  })

  test("an empty id asks the registry nothing", async () => {
    const requests: string[] = []
    await withHttpTestPolicy(registryOf(requests), async () => {
      expect(await biosimulators.fetch("  ")).toBeNull()
    })
    expect(requests).toEqual([])
  })

  test("a cancelled fetch rejects", async () => {
    await withHttpTestPolicy(registryOf(), async () => {
      await expect(biosimulators.fetch("tellurium", { signal: AbortSignal.abort() })).rejects.toBeInstanceOf(
        DOMException,
      )
    })
  })
})

test("biosimulators is registered as a keyless biology source without file formats", () => {
  expect(registry.get("biosimulators")).toBe(biosimulators)
  expect(registry.catalog().find((entry) => entry.id === "biosimulators")).toMatchObject({
    name: "BioSimulators",
    domain: "biology",
    homepage: "https://biosimulators.org",
  })
  expect(biosimulators.formats).toBeUndefined()
  expect(biosimulators.fetchFile).toBeUndefined()
})
