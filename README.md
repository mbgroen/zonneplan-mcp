# Zonneplan MCP

Onofficiële, alleen-lezen [MCP](https://modelcontextprotocol.io)-server voor **Zonneplan**. Hiermee kan Claude je stroomverbruik, teruglevering, gasverbruik, zonnepanelen, thuisbatterij, laadpaal en de dynamische energieprijzen opvragen, zonder dat je de Zonneplan-app opent.

De server wordt verpakt als `.mcpb`-bundel, zodat je hem in Claude Desktop met één klik installeert.

> Dit project is niet gelieerd aan of goedgekeurd door Zonneplan. Het gebruikt dezelfde (niet-publieke) API als de Zonneplan-app. Die API kan zonder aankondiging veranderen.

---

## Inhoud

- [Wat kun je ermee?](#wat-kun-je-ermee)
- [Installatie](#installatie)
- [Inloggen](#inloggen)
- [Voorbeeldvragen](#voorbeeldvragen)
- [Tools](#tools)
- [Eenheden en begrippen](#eenheden-en-begrippen)
- [Privacy en beveiliging](#privacy-en-beveiliging)
- [Configuratie](#configuratie)
- [Problemen oplossen](#problemen-oplossen)
- [Bekende beperkingen](#bekende-beperkingen)
- [Ontwikkelen](#ontwikkelen)
- [Een nieuwe release maken](#een-nieuwe-release-maken)
- [Hoe het werkt](#hoe-het-werkt)
- [Bronnen en licentie](#bronnen-en-licentie)

---

## Wat kun je ermee?

| Onderwerp | Wat je te zien krijgt |
|---|---|
| **P1-meter** (Zonneplan Connect) | Actuele afname en teruglevering in W, en het tijdstip van de laatste meting |
| **Stroom** | Afname van het net, teruglevering, netto verbruik, kosten en terugleververgoeding (incl. en excl. btw), voor vandaag, deze maand en dit jaar, of per uur voor een gekozen dag |
| **Thuisverbruik** | Totaal verbruik in huis, inclusief eigen zonnestroom (als Zonneplan dat levert) |
| **Gas** | Verbruik in m³ en kosten, als overzicht of per uur |
| **Zonnepanelen** | Actueel vermogen, opbrengst vandaag, totale opbrengst, aantal panelen en Wp, omvormer |
| **Thuisbatterij** | Laadniveau, vermogen, status, laadcycli, actieve sturingsmodus en Powerplay-opbrengst per dag en per maand |
| **Laadpaal** | Status en instellingen |
| **Prijzen** | Dynamische stroomprijzen per uur of kwartier en gasprijzen per dag: huidige prijs, goedkoopste en duurste moment, vandaag en morgen |

Alle tools **lezen alleen**. De server kan niets wijzigen aan je batterij, laadpaal of contract.

---

## Installatie

### Claude Desktop (aanbevolen)

1. Download `zonneplan-<versie>.mcpb` bij de nieuwste [release](https://github.com/mbgroen/zonneplan-mcp/releases/latest).
2. Dubbelklik op het bestand, of ga in Claude Desktop naar **Instellingen → Extensies** en sleep het bestand in het venster.
3. Klik op **Installeren** en vul het **e-mailadres van je Zonneplan-account** in.
4. Zet de extensie aan.

Je hebt geen aparte Node.js-installatie nodig, want Claude Desktop heeft een eigen Node-runtime.

### Handmatig (zonder bundel)

Voor ontwikkeling of andere MCP-clients kun je de server ook direct starten. Bouw eerst de bundel (zie [Ontwikkelen](#ontwikkelen)) en voeg daarna dit toe aan `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "zonneplan": {
      "command": "node",
      "args": ["/pad/naar/zonneplan-mcp/bundle/server/index.cjs"],
      "env": {
        "ZONNEPLAN_EMAIL": "jij@example.com"
      }
    }
  }
}
```

---

## Inloggen

Zonneplan gebruikt geen wachtwoord, maar een code per e-mail. Dat gaat zo:

1. Vraag Claude: *"Log in bij Zonneplan."*
2. Claude roept `zonneplan_login_start` aan. Zonneplan mailt je dan een **6-cijferige code**.
3. Geef de code aan Claude, bijvoorbeeld: *"De code is 123456."*
4. Claude roept `zonneplan_login_complete` aan. Daarmee ben je ingelogd.

Dit hoef je maar één keer te doen. Het access token wordt automatisch vernieuwd met het refresh token. Alleen als Zonneplan de sessie intrekt, moet je opnieuw inloggen.

In de Zonneplan-app staat de koppeling als **"Claude (Zonneplan MCP) - \<computernaam\>"**.

Uitloggen: *"Log uit bij Zonneplan."* Dat verwijdert de lokaal opgeslagen tokens.

---

## Voorbeeldvragen

**Verbruik en teruglevering**
- "Hoeveel stroom heb ik vandaag verbruikt en teruggeleverd?"
- "Wat zijn mijn netto stroomkosten deze maand?"
- "Laat mijn verbruik per uur van 1 oktober zien. Wanneer was het piekverbruik?"
- "Hoeveel heb ik dit jaar teruggeleverd en wat heeft dat opgeleverd?"

**Actueel**
- "Wat verbruik ik op dit moment?"
- "Lever ik nu terug?"

**Zonnepanelen en batterij**
- "Hoeveel hebben mijn zonnepanelen vandaag opgewekt?"
- "Wat is het laadniveau van mijn thuisbatterij?"
- "Hoeveel heeft Powerplay per maand opgeleverd dit jaar?"

**Prijzen**
- "Wat kost stroom nu?"
- "Wanneer is stroom morgen het goedkoopst? Ik wil de vaatwasser laten draaien."
- "Geef de kwartierprijzen van vandaag."
- "Wat is de gasprijs vandaag?"

**Gas**
- "Hoeveel gas heb ik deze maand verbruikt en wat kostte dat?"

---

## Tools

Alle parameters zijn optioneel, tenzij anders aangegeven. Bij meerdere aansluitingen kies je er een met `connection_uuid`. Zonder die parameter kiest de server zelf de juiste aansluiting.

### Account en inloggen

| Tool | Parameters | Beschrijving |
|---|---|---|
| `zonneplan_status` | – | Inlogstatus, naam, adres(sen), aansluitingen (uuid, EAN) en alle contracten en installaties. Begin hiermee. |
| `zonneplan_login_start` | `email` | Laat Zonneplan een inlogcode mailen. Zonder `email` wordt het adres uit de extensie-instellingen gebruikt. |
| `zonneplan_login_complete` | `code` (verplicht, 6 cijfers) | Rondt het inloggen af en slaat de tokens op. |
| `zonneplan_logout` | – | Verwijdert de lokaal opgeslagen tokens. |

### Data

| Tool | Parameters | Beschrijving |
|---|---|---|
| `zonneplan_live` | – | Actuele waarden van alle installaties: P1-vermogen (W), vermogen en totaal van de zonnepanelen, laadniveau en vermogen van de batterij, en de verbruikssamenvatting van Zonneplan. |
| `zonneplan_electricity` | `date`, `period`, `include_measurements`, `include_home_consumption`, `connection_uuid`, `raw` | Zonder `date`: overzicht van de perioden die Zonneplan levert (vandaag, maand, jaar) met afname, teruglevering, netto en kosten. Met `date` (`JJJJ-MM-DD`): grafiekdata met resolutie `period` = `hours` (standaard), `days`, `months` of `years`. |
| `zonneplan_gas` | `date`, `period`, `include_measurements`, `connection_uuid`, `raw` | Gasverbruik in m³ en kosten. Werkt hetzelfde als `zonneplan_electricity`. |
| `zonneplan_solar` | `include_measurements`, `connection_uuid`, `raw` | Zonnepanelen: actueel vermogen, opbrengst per periode, totaal, panelen, Wp en omvormer. |
| `zonneplan_battery` | `include_charts`, `connection_uuid`, `raw` | Thuisbatterij: status, laadniveau, vermogen, opbrengst en sturingsmodus. Met `include_charts: true` ook de opbrengst per maand (dit jaar) en per dag (deze maand). |
| `zonneplan_charge_point` | `connection_uuid` | Status van de laadpaal. |
| `zonneplan_prices` | `energy` (`electricity`/`gas`), `resolution` (`hour`/`quarter`), `day` (`today`/`tomorrow`/`all`) | Dynamische prijzen met de huidige prijs, de samenvatting voor vandaag, vanaf nu en morgen (goedkoopst, duurst, gemiddeld) en de volledige prijslijst. |
| `zonneplan_api_get` | `path` (verplicht) | Geavanceerd: ruwe GET-aanroep op `app-api.zonneplan.nl`. Alleen paden die met `/` beginnen. Zie [API-endpoints](#api-endpoints). |

Met `raw: true` krijg je het onbewerkte API-antwoord. Dat is handig om te debuggen of als Zonneplan velden heeft toegevoegd.

---

## Eenheden en begrippen

De Zonneplan-API gebruikt eigen eenheden. De server rekent ze om, en de eenheid staat steeds in de veldnaam:

| API-eenheid | Omgerekend naar | Veldnaam eindigt op |
|---|---|---|
| Wh | kWh (÷ 1.000) | `_kwh` |
| W | W | `_w` |
| dm³ (gas) | m³ (÷ 1.000) | `_m3` |
| 1/10.000.000 euro | euro (÷ 10⁷) | `_eur` |
| promille (laadniveau, duurzaamheid) | procent (÷ 10) | `_pct` |

Tijden staan in Nederlandse tijd (`Europe/Amsterdam`), als `JJJJ-MM-DD UU:MM`.

**Begrippen**
- **afname_van_net**: stroom die je van het net haalt. In de API heet dit `d` (delivery).
- **teruglevering_aan_net**: stroom die je aan het net levert. In de API heet dit `p` (production).
- **netto_afname**: afname min teruglevering.
- **delivery_costs**: kosten van de afgenomen stroom of het gas.
- **production_costs**: vergoeding voor teruglevering.
- **netto_kosten_incl_btw**: kosten min vergoeding.

---

## Privacy en beveiliging

- **Lokale opslag**: tokens staan in `~/.zonneplan-mcp/tokens.json` (Windows: `%USERPROFILE%\.zonneplan-mcp\tokens.json`). Map en bestand zijn alleen leesbaar voor jouw gebruiker (rechten `700`/`600`).
- **Eén bestemming**: de server praat alleen met `https://app-api.zonneplan.nl`. Er is geen telemetrie en er gaat geen data naar derden.
- **Alleen lezen**: er zijn geen tools die iets wijzigen. `zonneplan_api_get` doet alleen GET-requests en accepteert geen andere host.
- **Wat Claude ziet**: de antwoorden van de tools, zoals verbruiksdata, adres en EAN, komen in je gesprek met Claude terecht.
- **Intrekken**: verwijder de map `~/.zonneplan-mcp`, of verwijder de koppeling in de Zonneplan-app.

---

## Configuratie

Omgevingsvariabelen (in de bundel wordt `ZONNEPLAN_EMAIL` automatisch gevuld vanuit de extensie-instellingen):

| Variabele | Standaard | Doel |
|---|---|---|
| `ZONNEPLAN_EMAIL` | – | E-mailadres voor de inlogcode |
| `ZONNEPLAN_STATE_DIR` | `~/.zonneplan-mcp` | Map voor tokens en een lopende inlogpoging |
| `ZONNEPLAN_APP_VERSION` | `5.10.1` | Waarde van de header `x-app-version` (aanpassen als Zonneplan oude app-versies weigert) |
| `ZONNEPLAN_API_BASE` | `https://app-api.zonneplan.nl` | Alleen voor tests met een nep-API |

---

## Problemen oplossen

| Probleem | Oplossing |
|---|---|
| "Nog niet ingelogd" | Vraag Claude om in te loggen bij Zonneplan. |
| "Sessie verlopen of ingetrokken" | Log opnieuw in. |
| "De code werd niet geaccepteerd" | De code is fout of verlopen. Vraag een nieuwe aan. |
| "Rate limit bereikt" (429) | Zonneplan begrenst het aantal aanvragen. Wacht een paar minuten. |
| Status 4xx bij alle aanroepen | Mogelijk weigert Zonneplan de app-versie. Probeer een hogere `ZONNEPLAN_APP_VERSION`. |
| Veld ontbreekt of ziet er vreemd uit | Roep de tool aan met `raw: true`, of gebruik `zonneplan_api_get`, en open een [issue](https://github.com/mbgroen/zonneplan-mcp/issues). |
| "Geen gasdata gevonden" | De aansluiting heeft geen gas (all-electric), of de P1-meter meet geen gas. |

**Logs** (Claude Desktop):
- macOS: `~/Library/Logs/Claude/`, het bestand `mcp-server-…` met "Zonneplan" in de naam
- Windows: `%APPDATA%\Claude\logs\`, hetzelfde bestand

---

## Bekende beperkingen

- De Zonneplan-API is niet publiek gedocumenteerd. Endpoints en velden zijn afgeleid uit de Homey-app en de Home Assistant-integratie (zie [Bronnen](#bronnen-en-licentie)).
- Bij historische stroom- en gasdata is de resolutie `hours` bevestigd. `days`, `months` en `years` volgen hetzelfde patroon, maar zijn niet bevestigd. Geeft Zonneplan daar een fout, gebruik dan het overzicht zonder datum of de uurdata.
- Batterijsturing en laadpaalacties (zoals boost laden) zitten er bewust niet in: deze server leest alleen.

---

## Ontwikkelen

Vereist: Node.js 18 of hoger.

```bash
git clone https://github.com/mbgroen/zonneplan-mcp.git
cd zonneplan-mcp
npm install

npm run build   # bundelt src/index.js → bundle/server/index.cjs (esbuild, één bestand zonder node_modules)
npm test        # build + end-to-end test tegen een nep-Zonneplan-API
npm run pack    # build + manifest valideren + zonneplan.mcpb maken
```

### Projectstructuur

```
.
├── src/index.js              # De MCP-server (alle tools, auth, conversies)
├── bundle/                   # Inhoud van de .mcpb-bundel
│   ├── manifest.json         # MCPB-manifest (naam, tools, user_config)
│   ├── icon.png
│   ├── README.md             # Korte handleiding in de bundel
│   ├── LICENSE
│   └── server/index.cjs      # Gegenereerd door `npm run build` (niet in git)
├── test/mock-test.cjs        # E2E-test: login, token refresh en alle tools tegen een mock-API
├── scripts/set-version.cjs   # Zet het versienummer in package.json en manifest.json
└── .github/workflows/
    ├── ci.yml                # Test + bundel bij elke push en pull request
    └── release.yml           # Bouwt de .mcpb en hangt hem aan elke release
```

### De test

`npm test` start een lokale nep-API die zich gedraagt als Zonneplan en loopt het hele pad door:

- inloggen met een foute en een goede code;
- tokens opslaan met rechten `600`;
- een verlopen access token automatisch vernieuwen;
- alle data-tools aanroepen;
- invoervalidatie controleren, zoals het weigeren van een andere host in `zonneplan_api_get`;
- uitloggen.

---

## Een nieuwe release maken

Een release maken is één handeling; de rest doet `.github/workflows/release.yml` vanzelf.

**Optie 1: een tag pushen** (de release wordt automatisch aangemaakt)

```bash
git tag v1.2.3
git push origin v1.2.3
```

**Optie 2: via GitHub.** Ga naar **Releases → Draft a new release**, typ een nieuwe tag (bijv. `v1.2.3`) en klik op **Publish release**.

Daarna doet de workflow automatisch het volgende:

1. Hij leest het versienummer uit de tag (`v1.2.3` → `1.2.3`) en zet het in `package.json` en `manifest.json`.
2. Hij installeert de dependencies, draait de tests en bouwt de bundel. Mislukt een test, dan komt er geen release.
3. Bestaat de release nog niet (optie 1), dan maakt hij hem aan, met installatie-instructies en automatisch gegenereerde release notes.
4. Hij voegt `zonneplan-1.2.3.mcpb` toe aan de assets van de release.

Na een paar minuten staat de release met de download klaar. Ging er iets mis, dan kun je de workflow opnieuw draaien via **Actions → Release → Run workflow** met de bestaande tag.

Werk het versienummer in `package.json` en `bundle/manifest.json` gerust ook bij in een commit (`node scripts/set-version.cjs 1.2.3`). De workflow gebruikt hoe dan ook de tag.

---

## Hoe het werkt

### Inloggen (OAuth 2.0 + PKCE met e-mailcode)

```
POST /oauth/authorize-challenge   {response_type: "code", email, code_challenge, code_challenge_method: "S256", source_name}
  → 403 {auth_session, otp_required: true, expires_in}     (403 is hier het verwachte antwoord)
POST /oauth/authorize-challenge   {auth_session, otp}
  → 200 {authorization_code}
POST /oauth/token                 {grant_type: "authorization_code", code, code_verifier}
  → {access_token, refresh_token, expires_in}
POST /oauth/token                 {grant_type: "refresh_token", refresh_token}   (automatisch bij verlopen token of 401)
```

Elke request stuurt de headers `x-app-version`, `x-app-environment: production` en een `User-Agent` mee, anders weigert Zonneplan het verzoek.

### API-endpoints

| Endpoint | Gebruikt door |
|---|---|
| `GET /user-accounts/me` | `zonneplan_status`, `zonneplan_live` (bevat ook de actuele meta van alle contracten) |
| `GET /connections/{aansluiting}/summary` | `zonneplan_live` |
| `GET /connections/{aansluiting}/electricity-delivered` | `zonneplan_electricity` |
| `GET /connections/{aansluiting}/electricity-delivered/charts/{hours\|days\|months\|years}?date=JJJJ-MM-DD` | `zonneplan_electricity` met `date` |
| `GET /connections/{aansluiting}/electricity-home-consumption` | `zonneplan_electricity` |
| `GET /connections/{aansluiting}/gas` | `zonneplan_gas` |
| `GET /connections/{aansluiting}/gas/charts/{periode}?date=JJJJ-MM-DD` | `zonneplan_gas` met `date` |
| `GET /connections/{aansluiting}/pv-installation` | `zonneplan_solar` |
| `GET /connections/{aansluiting}/home-battery-installation/{batterij}` | `zonneplan_battery` |
| `GET /api/contracts/{batterij}/home-battery/control-mode` | `zonneplan_battery` |
| `GET /contracts/{batterij}/home_battery_installation/charts/{months\|days}?date=JJJJ-MM-DD` | `zonneplan_battery` met `include_charts` |
| `GET /connections/{aansluiting}/charge-points/{laadpaal}` | `zonneplan_charge_point` |
| `GET /api/consumer-prices/charts/{electricity-hourly\|electricity-quarter-hourly\|gas-daily}` | `zonneplan_prices` |

Contracttypen in `/user-accounts/me`: `p1_installation`, `pv_installation`, `home_battery_installation` en `charge_point_installation`. Daarnaast staan er de leveringscontracten voor stroom en gas.

---

## Bronnen en licentie

De kennis over de Zonneplan-API komt uit:

- [biemond/nl.zonneplan](https://github.com/biemond/nl.zonneplan): Homey-app voor Zonneplan (GPL-3.0)
- [fsaris/home-assistant-zonneplan-one](https://github.com/fsaris/home-assistant-zonneplan-one): Home Assistant-integratie voor Zonneplan

Licentie: [GPL-3.0-or-later](LICENSE).

"Zonneplan" is een handelsnaam van Zonneplan B.V. Dit project is daar niet aan verbonden.
