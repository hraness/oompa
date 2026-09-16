/** Curated resource directory rendered at the bottom of /pr/. */

export interface PrResourceGroup {
  readonly heading: string;
  readonly links: readonly Readonly<{ label: string; url: string; note?: string }>[];
}

export const PR_RESOURCES: readonly PrResourceGroup[] = [
  {
    heading: "Emergencies & official response",
    links: [
      { label: "911", url: "https://www.pr.gov/", note: "Life-safety emergencies in Puerto Rico" },
      { label: "NMEAD: Negociado para el Manejo de Emergencias", url: "https://manejodeemergencias.pr.gov/", note: "Emergency management bureau; shelter and disaster guidance" },
      { label: "FEMA Disaster Assistance", url: "https://www.disasterassistance.gov/", note: "Federal aid applications after declarations" },
      { label: "PR 2-1-1", url: "https://211pr.org/", note: "Community helpline for food, shelter, health resources" },
      { label: "Departamento de Salud", url: "https://www.salud.pr.gov/", note: "Health alerts, dengue surveillance, drinking water advisories" },
    ],
  },
  {
    heading: "Power & water",
    links: [
      { label: "LUMA outage map", url: "https://miluma.lumapr.com/outages/outageMap", note: "Live customer outages by region" },
      { label: "LUMA notable outages", url: "https://lumapr.com/notable-outages/?lang=en", note: "Utility-posted outage explanations" },
      { label: "AAA: Acueductos y Alcantarillados", url: "https://www.acueductospr.com/", note: "Water service notices" },
      { label: "AAA reservoir levels", url: "https://www.acueductospr.com/infraestructura/niveles-de-los-embalses", note: "Daily embalse reports" },
      { label: "AAA planned interruptions", url: "https://www.acueductospr.com/planes-de-interrupciones-programadas-2026", note: "Scheduled water shutoffs" },
      { label: "PowerOutage.us: Puerto Rico", url: "https://poweroutage.us/area/state/puerto%20rico", note: "Independent outage tracking" },
    ],
  },
  {
    heading: "Weather, water & earth",
    links: [
      { label: "NWS San Juan", url: "https://www.weather.gov/sju/", note: "Watches, warnings, forecasts for PR & USVI" },
      { label: "NWS active alerts", url: "https://alerts.weather.gov/cap/pr.php?x=0", note: "CAP feed for Puerto Rico" },
      { label: "National Hurricane Center", url: "https://www.nhc.noaa.gov/", note: "Atlantic tropical outlook and advisories" },
      { label: "NOAA tsunami warnings", url: "https://www.tsunami.gov/", note: "Atlantic & Caribbean tsunami messages" },
      { label: "Puerto Rico Seismic Network", url: "https://redsismica.uprm.edu/", note: "Local seismic monitoring (UPR Mayagüez)" },
      { label: "USGS earthquakes", url: "https://earthquake.usgs.gov/earthquakes/map/?extent=15.5,-69.5&extent=20.5,-63", note: "Regional quake map" },
      { label: "USGS WaterWatch PR", url: "https://waterwatch.usgs.gov/?m=real&r=pr", note: "Real-time stream gauges" },
      { label: "U.S. Drought Monitor: PR", url: "https://droughtmonitor.unl.edu/CurrentMap/StateDroughtMonitor.aspx?PR", note: "Weekly drought classification" },
      { label: "NOAA tides: San Juan", url: "https://tidesandcurrents.noaa.gov/stationhome.html?id=9755371", note: "Observed vs predicted water levels" },
      { label: "CariCOF: Caribbean climate outlooks", url: "https://rcc.cimh.edu.bb/", note: "Regional drought and rainfall outlooks" },
      { label: "NOAA space weather", url: "https://www.swpc.noaa.gov/products/alerts-and-forecasts", note: "Geomagnetic storm alerts" },
    ],
  },
  {
    heading: "Transport & supply",
    links: [
      { label: "Puerto Rico Ferry", url: "https://www.puertoricoferry.com/", note: "Ceiba–Vieques–Culebra service alerts" },
      { label: "San Juan airport (SJU)", url: "https://www.aeropuertosju.com/", note: "Flight status and advisories" },
      { label: "DTOP road conditions", url: "https://www.dtop.pr.gov/", note: "Highway authority advisories" },
      { label: "USCG Sector San Juan", url: "https://www.dvidshub.net/unit/PADETSanJuan", note: "Port conditions, SAR, interdictions" },
      { label: "Crowley Maritime: PR service", url: "https://www.crowley.com/", note: "Jones Act cargo carrier advisories" },
      { label: "TOTE Maritime", url: "https://www.totemaritime.com/", note: "San Juan service updates" },
      { label: "DACO fuel prices", url: "https://www.daco.pr.gov/", note: "Consumer-affairs fuel price reports" },
    ],
  },
  {
    heading: "Connectivity & independent monitoring",
    links: [
      { label: "IODA: Puerto Rico", url: "https://ioda.inetintel.cc.gatech.edu/country/PR", note: "Internet outage detection (Georgia Tech)" },
      { label: "Cloudflare Radar: PR", url: "https://radar.cloudflare.com/pr", note: "Traffic anomalies island-wide" },
      { label: "FCC DIRS", url: "https://www.fcc.gov/disaster-information-reporting-system-dirs", note: "Cell-site outage reports during disasters" },
      { label: "GDACS", url: "https://www.gdacs.org/", note: "UN/EU global disaster alerts" },
      { label: "ReliefWeb: Puerto Rico", url: "https://reliefweb.int/country/pri", note: "OCHA humanitarian reports" },
      { label: "CDEMA", url: "https://www.cdema.org/", note: "Caribbean disaster coordination" },
    ],
  },
  {
    heading: "Newsrooms worth following",
    links: [
      { label: "El Nuevo Día", url: "https://www.elnuevodia.com/" },
      { label: "Primera Hora", url: "https://www.primerahora.com/" },
      { label: "NotiCel", url: "https://noticel.com/" },
      { label: "Metro Puerto Rico", url: "https://www.metro.pr/" },
      { label: "El Vocero", url: "https://www.elvocero.com/" },
      { label: "Centro de Periodismo Investigativo", url: "https://periodismoinvestigativo.com/" },
      { label: "TeleOnce", url: "https://www.teleonce.com/" },
      { label: "WIPR (public media)", url: "https://www.wipr.pr/" },
    ],
  },
];
