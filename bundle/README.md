# Zonneplan MCP voor Claude (onofficieel)

Alleen-lezen koppeling tussen Claude Desktop en je Zonneplan-account. Je kunt je energiegegevens opvragen zonder de Zonneplan-app te openen.

## Installeren

1. Dubbelklik op `zonneplan.mcpb`, of ga in Claude Desktop naar **Instellingen → Extensies** en sleep het bestand erin.
2. Klik op **Installeren** en vul het e-mailadres van je Zonneplan-account in.
3. Zet de extensie aan.

## Eerste keer inloggen

Vraag Claude bijvoorbeeld: *"Log in bij Zonneplan"*.

1. Claude vraagt een code aan en Zonneplan mailt je een **6-cijferige code**.
2. Geef die code aan Claude in de chat.
3. Klaar. De sessie wordt lokaal opgeslagen en automatisch vernieuwd, dus je hoeft dit maar één keer te doen.

In de Zonneplan-app zie je de koppeling terug als "Claude (Zonneplan MCP)".

## Voorbeeldvragen

- "Hoeveel stroom heb ik vandaag verbruikt en teruggeleverd?"
- "Wat zijn mijn netto stroomkosten deze maand?"
- "Laat mijn verbruik per uur van 1 oktober zien."
- "Hoeveel hebben mijn zonnepanelen vandaag opgewekt?"
- "Wat is het laadniveau van mijn thuisbatterij en hoeveel heeft Powerplay deze maand opgeleverd?"
- "Wanneer is stroom morgen het goedkoopst?"
- "Hoeveel gas heb ik dit jaar verbruikt?"

## Tools

| Tool | Wat het doet |
|---|---|
| `zonneplan_status` | Inlogstatus, adres, aansluitingen (EAN) en installaties |
| `zonneplan_login_start` / `zonneplan_login_complete` | Inloggen met e-mailcode |
| `zonneplan_live` | Actueel vermogen van de P1-meter, zonnepanelen en batterij |
| `zonneplan_electricity` | Afname, teruglevering, netto en kosten. Zonder datum geeft het vandaag, deze maand en dit jaar; met datum per uur, dag, maand of jaar |
| `zonneplan_gas` | Gasverbruik (m³) en kosten |
| `zonneplan_solar` | Opbrengst en status van de zonnepanelen |
| `zonneplan_battery` | Thuisbatterij: laadniveau, sturingsmodus, Powerplay-opbrengst |
| `zonneplan_charge_point` | Laadpaalstatus |
| `zonneplan_prices` | Dynamische stroom- en gasprijzen voor vandaag en morgen |
| `zonneplan_api_get` | Ruwe GET-aanroep, voor als je iets wilt opvragen waar (nog) geen tool voor is |
| `zonneplan_logout` | Tokens van deze computer verwijderen |

Alle tools lezen alleen. De extensie kan niets aan je batterij, laadpaal of contract veranderen.

## Privacy en opslag

- Tokens staan in `~/.zonneplan-mcp/tokens.json` en alleen jouw gebruiker kan ze lezen (rechten 600).
- De extensie praat alleen met `app-api.zonneplan.nl`, verder met niemand.
- Uitloggen kan via "log uit bij Zonneplan" (de tool `zonneplan_logout`), of door de map `~/.zonneplan-mcp` te verwijderen.

## Problemen oplossen

- **"Sessie verlopen"**: log opnieuw in.
- **Rate limit (429)**: Zonneplan begrenst het aantal aanvragen. Wacht een paar minuten.
- **Ontbrekende of vreemde data**: vraag Claude om dezelfde tool met `raw: true` aan te roepen, of gebruik `zonneplan_api_get`. Zo zie je het onbewerkte antwoord van de API.
- **Logs**: in Claude Desktop onder Instellingen → Extensies → Zonneplan, of in `~/Library/Logs/Claude/mcp-server-Zonneplan*.log` (macOS).

## Eenheden

De Zonneplan-API levert energie in Wh, gas in dm³ en bedragen in 1/10.000.000 euro. Deze extensie rekent dat om naar kWh, m³ en euro. De eenheid staat steeds in de veldnaam (`_kwh`, `_w`, `_eur`, `_m3`). Tijden worden getoond in Nederlandse tijd.

## Bron en licentie

De kennis over de Zonneplan-API komt uit [biemond/nl.zonneplan](https://github.com/biemond/nl.zonneplan) (Homey-app) en [fsaris/home-assistant-zonneplan-one](https://github.com/fsaris/home-assistant-zonneplan-one). Licentie: GPL-3.0-or-later. Dit project is niet gelieerd aan Zonneplan. Zonneplan kan de API op elk moment wijzigen.
