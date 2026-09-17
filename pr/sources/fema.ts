import { z } from "zod";

import { signalId } from "../classify.ts";
import type { PrSignal } from "../model.ts";
import type { PulseSource } from "../source.ts";

const femaDeclarationsSchema = z.object({
  DisasterDeclarationsSummaries: z.array(z.object({
    disasterNumber: z.number().optional(),
    declarationDate: z.string().optional(),
    declarationTitle: z.string().optional(),
    declarationType: z.string().optional(),
    incidentType: z.string().optional(),
    incidentBeginDate: z.string().optional(),
    incidentEndDate: z.string().nullable().optional(),
    state: z.string().optional(),
    ihProgramDeclared: z.boolean().optional(),
    paProgramDeclared: z.boolean().optional(),
    hmProgramDeclared: z.boolean().optional(),
  }).passthrough()).optional(),
}).passthrough();

export const femaDeclarationsSource: PulseSource = {
  id: "fema-declarations",
  name: "FEMA OpenFEMA",
  category: "official",
  homepage: "https://www.fema.gov/about/openfema/data-sets",
  collect: async (ctx) => {
    const url = "https://www.fema.gov/api/open/v2/DisasterDeclarationsSummaries"
      + "?$filter=state%20eq%20%27PR%27&$orderby=declarationDate%20desc&$top=15";
    const parsed = femaDeclarationsSchema.parse(
      JSON.parse(await ctx.fetchText(url, { label: "fema.gov" })),
    );
    const declarations = parsed.DisasterDeclarationsSummaries ?? [];
    const cutoff = ctx.now.getTime() - 730 * 86_400_000;
    return declarations
      .filter((d) => d.declarationDate !== undefined && Date.parse(d.declarationDate) >= cutoff)
      .slice(0, 10)
      .map((d): PrSignal => ({
        id: signalId("fema", [d.disasterNumber?.toString() ?? "", d.declarationDate ?? ""]),
        source: "fema-declarations",
        sourceName: "FEMA disaster declarations",
        category: "official",
        severity: d.declarationType === "DR" ? "warning" : "advisory",
        title: `${d.declarationType ?? "EM"}-${d.disasterNumber?.toString() ?? "?"}: ${d.declarationTitle ?? "Disaster declaration"}`,
        summary: [
          d.incidentType !== undefined ? `Incident type: ${d.incidentType}.` : "",
          d.incidentBeginDate !== undefined ? `Incident began ${d.incidentBeginDate.slice(0, 10)}.` : "",
          d.ihProgramDeclared === true ? "Individual Assistance authorized." : "",
          d.paProgramDeclared === true ? "Public Assistance authorized." : "",
        ].filter((part) => part.length > 0).join(" "),
        url: `https://www.fema.gov/disaster/${d.disasterNumber?.toString() ?? ""}`,
        regions: ["islandwide"],
        lang: "en",
        issuedAt: d.declarationDate,
        expiresAt: undefined,
        metrics: undefined,
      }));
  },
};
