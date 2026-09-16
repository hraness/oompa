import type { PulseSource } from "../source.ts";

import { iodaPrSource } from "./connectivity.ts";
import { femaDeclarationsSource } from "./fema.ts";
import { gdeltSignalsSource } from "./gdelt.ts";
import { cdcTravelNoticesSource, prSaludSource } from "./health.ts";
import { lumaNotablesSource, lumaOutagesSource } from "./luma.ts";
import { googleNewsSource, localNewsSources } from "./news.ts";
import { nhcOutlookSource, nhcStormsSource } from "./nhc.ts";
import { cpcEnsoSource, noaaCoopsSource, swpcAlertsSource } from "./noaa.ts";
import {
  nwsMarineAlertsSource,
  nwsPrAlertsSource,
  nwsSjuProductsSource,
  nwsViAlertsSource,
} from "./nws.ts";
import { prasaEmbalsesSource, prasaInterruptionsSource } from "./prasa.ts";
import { caricofSource, gdacsCaribbeanSource, volcanoWeeklySource } from "./regional.ts";
import { fccDirsSource, prFerrySource } from "./transport.ts";
import { uscgSectorSanJuanSource } from "./uscg.ts";
import { usgsQuakesSource, usgsRiversSource } from "./usgs.ts";

export const PULSE_SOURCES: readonly PulseSource[] = [
  nwsPrAlertsSource,
  nwsViAlertsSource,
  nwsMarineAlertsSource,
  nwsSjuProductsSource,
  nhcStormsSource,
  nhcOutlookSource,
  usgsQuakesSource,
  usgsRiversSource,
  noaaCoopsSource,
  swpcAlertsSource,
  cpcEnsoSource,
  femaDeclarationsSource,
  lumaOutagesSource,
  lumaNotablesSource,
  prasaEmbalsesSource,
  prasaInterruptionsSource,
  uscgSectorSanJuanSource,
  prFerrySource,
  fccDirsSource,
  iodaPrSource,
  gdacsCaribbeanSource,
  volcanoWeeklySource,
  caricofSource,
  gdeltSignalsSource,
  cdcTravelNoticesSource,
  prSaludSource,
  ...localNewsSources,
  googleNewsSource,
];
