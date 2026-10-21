import { config } from "./config.js";
import { legalFooter, legalFooterStyles } from "./legal-footer.js";

type Language = "de" | "en";

interface SectionText {
  title: string;
  body: string | (() => string);
}

interface LegalSection {
  id: string;
  de: SectionText;
  en: SectionText;
}

function formatDuration(seconds: number, language: Language): string {
  const units = [
    [86400, "day"],
    [3600, "hour"],
    [60, "minute"],
    [1, "second"],
  ] as const;
  const [divisor, unit] = units.find(([divisor]) => seconds % divisor === 0) ?? units[3];
  return new Intl.NumberFormat(language, {
    style: "unit",
    unit,
    unitDisplay: "long",
  }).format(seconds / divisor);
}

function formatRetentionDays(language: Language): string {
  const days = config.anonymousPageRetentionDays;
  if (language === "de") {
    return days === 1 ? "einem Tag" : `${days.toLocaleString(language)} Tagen`;
  }
  return `${days.toLocaleString(language)} ${days === 1 ? "day" : "days"}`;
}

function formatVersions(language: Language): string {
  const count = config.maxPageVersions;
  const unit = language === "de" ? "Version" : "version";
  const suffix = language === "de" ? "en" : "s";
  return `${count.toLocaleString(language)} ${unit}${count === 1 ? "" : suffix}`;
}

const noticeSections: LegalSection[] = [
  {
    id: "notice-1",
    de: {
      title: "Anbieter",
      body: "<p>Tobias Heer<br>c/o Impressumservice Dein-Impressum<br>Stettiner Str. 41<br>35410 Hungen<br>Deutschland</p>",
    },
    en: {
      title: "Provider",
      body: "<p>Tobias Heer<br>c/o Impressumservice Dein-Impressum<br>Stettiner Str. 41<br>35410 Hungen<br>Germany</p>",
    },
  },
  {
    id: "notice-2",
    de: {
      title: "Kontakt",
      body: '<p>E-Mail: <a href="mailto:impressum-schaffa@heerlab.com">impressum-schaffa@heerlab.com</a><br>Kontaktformular: <a href="https://beastyrabbit.com/kontakt?from=schaffa">beastyrabbit.com/kontakt</a></p>',
    },
    en: {
      title: "Contact",
      body: '<p>E-mail: <a href="mailto:impressum-schaffa@heerlab.com">impressum-schaffa@heerlab.com</a><br>Contact form: <a href="https://beastyrabbit.com/kontakt?from=schaffa">beastyrabbit.com/kontakt</a></p>',
    },
  },
  {
    id: "notice-3",
    de: {
      title: "Hinweis",
      body: "<p>Schaffa ist ein privates, nicht-kommerzielles Projekt.</p>",
    },
    en: {
      title: "Note",
      body: "<p>Schaffa is a private, non-commercial project.</p>",
    },
  },
  {
    id: "notice-4",
    de: {
      title: "Datenschutz",
      body: '<p>Informationen zur Verarbeitung personenbezogener Daten finden Sie in der <a href="/datenschutz">Datenschutzerklärung</a>.</p>\n<p>Datenschutzanfragen: <a href="mailto:datenschutz-schaffa@heerlab.com">datenschutz-schaffa@heerlab.com</a>.</p>',
    },
    en: {
      title: "Privacy",
      body: '<p>For information on how personal data is processed, see the <a href="/privacy">Privacy Policy</a>.</p>\n<p>Privacy requests: <a href="mailto:datenschutz-schaffa@heerlab.com">datenschutz-schaffa@heerlab.com</a>.</p>',
    },
  },
];

const privacySections: LegalSection[] = [
  {
    id: "privacy-1",
    de: {
      title: "Verantwortlicher",
      body: '<p>Verantwortlich für die Verarbeitung personenbezogener Daten auf https://schaffa.dev ist:</p>\n<p>Tobias Heer<br>c/o Impressumservice Dein-Impressum<br>Stettiner Str. 41<br>35410 Hungen<br>Deutschland</p>\n<p>E-Mail: <a href="mailto:datenschutz-schaffa@heerlab.com">datenschutz-schaffa@heerlab.com</a></p>\n<p>Weitere Kontaktmöglichkeit: <a href="https://beastyrabbit.com/kontakt?from=schaffa">beastyrabbit.com/kontakt</a>, <a href="mailto:impressum-schaffa@heerlab.com">impressum-schaffa@heerlab.com</a>.</p>\n<p>Ein Datenschutzbeauftragter ist nicht bestellt, da hierzu keine gesetzliche Pflicht besteht.</p>',
    },
    en: {
      title: "Controller",
      body: '<p>The controller responsible for processing personal data on https://schaffa.dev is:</p>\n<p>Tobias Heer<br>c/o Impressumservice Dein-Impressum<br>Stettiner Str. 41<br>35410 Hungen<br>Germany</p>\n<p>E-mail: <a href="mailto:datenschutz-schaffa@heerlab.com">datenschutz-schaffa@heerlab.com</a></p>\n<p>Additional contact: <a href="https://beastyrabbit.com/kontakt?from=schaffa">beastyrabbit.com/kontakt</a>, <a href="mailto:impressum-schaffa@heerlab.com">impressum-schaffa@heerlab.com</a>.</p>\n<p>No data protection officer has been appointed, as there is no legal obligation to do so.</p>',
    },
  },
  {
    id: "privacy-2",
    de: {
      title: "Überblick",
      body: "<p>Diese Erklärung informiert darüber, welche personenbezogenen Daten bei der Nutzung von Schaffa verarbeitet werden, zu welchen Zwecken, auf welcher Rechtsgrundlage und wie lange. Schaffa ist ein privates, nicht-kommerzielles Projekt. Schaffa veröffentlicht HTML-Seiten, Dateien, Schritt-für-Schritt-Guides und Präsentationen über öffentliche Links.</p>\n<p>Personenbezogene Daten werden nicht verkauft und nicht für Werbung verwendet. Eine automatisierte Entscheidungsfindung einschließlich Profiling im Sinne von Art. 22 DSGVO findet nicht statt.</p>",
    },
    en: {
      title: "Overview",
      body: "<p>This policy explains which personal data is processed when you use Schaffa, for what purposes, on which legal basis, and for how long. Schaffa is a private, non-commercial project. Schaffa publishes HTML pages, files, step-by-step guides and presentations through public links.</p>\n<p>Personal data is not sold and not used for advertising. There is no automated decision-making, including profiling, within the meaning of Art. 22 GDPR.</p>",
    },
  },
  {
    id: "privacy-3",
    de: {
      title: "Hosting und Bereitstellung",
      body: "<p>Schaffa läuft auf eigener Server-Infrastruktur des Verantwortlichen in Deutschland. Aufrufe aus dem Internet erreichen die Anwendung über einen Reverse-Proxy auf einem virtuellen Server der netcup GmbH, Emmy-Noether-Straße 10, 76131 Karlsruhe, Deutschland (Rechenzentrum in Nürnberg). netcup verarbeitet die Daten dabei als Auftragsverarbeiter; mit netcup besteht ein Vertrag zur Auftragsverarbeitung nach Art. 28 DSGVO. Die Verbindung ist bis zum Reverse-Proxy TLS-verschlüsselt und wird von dort durch einen verschlüsselten Tunnel an die eigene Infrastruktur weitergeleitet.</p>\n<p>Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO. Das berechtigte Interesse liegt in einer sicheren und zuverlässigen Bereitstellung der Website.</p>\n<p>Sicherungskopien werden innerhalb der eigenen Infrastruktur gespeichert und nach spätestens drei Monaten überschrieben.</p>",
    },
    en: {
      title: "Hosting and delivery",
      body: "<p>Schaffa runs on the controller's own server infrastructure in Germany. Requests from the internet reach the application through a reverse proxy on a virtual server operated by netcup GmbH, Emmy-Noether-Straße 10, 76131 Karlsruhe, Germany (data center in Nuremberg). netcup processes the data as a processor under a data processing agreement pursuant to Art. 28 GDPR. The connection is TLS-encrypted up to the reverse proxy and forwarded from there to the controller's infrastructure through an encrypted tunnel.</p>\n<p>The legal basis is Art. 6(1)(f) GDPR. The legitimate interest is the secure and reliable provision of the website.</p>\n<p>Backups are stored within the controller's own infrastructure and overwritten after at most three months.</p>",
    },
  },
  {
    id: "privacy-4",
    de: {
      title: "Server-Logfiles",
      body: "<p>Bei jedem Aufruf speichert der Reverse-Proxy automatisch folgende Daten:</p>\n<ul><li>IP-Adresse des anfragenden Geräts</li><li>Datum und Uhrzeit des Zugriffs</li><li>aufgerufene Adresse (Pfad einschließlich Parameter), HTTP-Methode und Protokoll</li><li>HTTP-Statuscode, übertragene Datenmenge und Antwortzeit</li><li>Browser-Kennung (User-Agent)</li><li>verwendete TLS-Version und Verschlüsselung</li><li>angesprochener Dienst</li></ul>\n<p>Die Header Cookie und Authorization werden geschwärzt. URL-Pfade und Abfrageparameter werden protokolliert.</p>\n<p>Die Daten dienen dem Betrieb, der Fehleranalyse und der Abwehr von Angriffen und Missbrauch. Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO. Das berechtigte Interesse liegt in Stabilität und Sicherheit des Angebots. Die Logfiles werden nach 14 Tagen automatisch gelöscht.</p>\n<p>Pangolin speichert HTTP-Anfragen für 14 Tage, Netzwerkprotokolle für 30 Tage und Anmeldeprotokolle für 90 Tage. Die Verarbeitung dient dem sicheren Betrieb und der Zugangskontrolle auf Grundlage von Art. 6 Abs. 1 lit. f DSGVO. Administrative Aktionen des Betreibers werden für 7 Tage protokolliert.</p>\n<p>Die Anwendung protokolliert bei Anfragen insbesondere Anfragekennung, Methode, URL einschließlich Parametern, Hostname, IP-Adresse und Port sowie Antwortstatus und Antwortzeit. Unerwartete Fehler können mit Diagnoseinformationen und Stacktrace protokolliert werden. Anfragekörper und Kontoprofile werden durch die Anwendung nicht gezielt protokolliert; Cookie- und Authorization-Header werden geschwärzt. Die Protokolle liegen als Kubernetes-Containerlogs auf eigener Infrastruktur ohne zentrale Logsammlung. Kubernetes rotiert diese Protokolle nach Größe (10 MiB je Datei, höchstens fünf Dateien je Container). Eine zeitliche Höchstaufbewahrung ist nicht festgelegt. Beim Ersetzen des Containers werden seine Protokolle entfernt.</p>\n<p>Zur Begrenzung von Uploads und Anmeldeversuchen speichert Schaffa einen mit einem geheimen Schlüssel gebildeten Hash der IP-Adresse oder die Token-ID zusammen mit dem Zeitpunkt in SQLite. Die Anwendung speichert hierfür keine Klartext-IP. Gezählt wird über eine Stunde. Einträge, die älter als einen Tag sind, werden erst bei einer späteren erfolgreichen Limit-Prüfung gelöscht. Es gibt keinen zeitgesteuerten Löschlauf. Zweck und berechtigtes Interesse sind die Missbrauchsabwehr, Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO. Sicherungen sind im Abschnitt zu Nutzerkonto und Inhalten beschrieben.</p>",
    },
    en: {
      title: "Server log files",
      body: "<p>For every request, the reverse proxy automatically stores the following data:</p>\n<ul><li>IP address of the requesting device</li><li>date and time of access</li><li>requested address (path including parameters), HTTP method and protocol</li><li>HTTP status code, amount of data transferred, and response time</li><li>browser identifier (user agent)</li><li>TLS version and cipher used</li><li>target service</li></ul>\n<p>The Cookie and Authorization headers are redacted. URL paths and query parameters are logged.</p>\n<p>This data is used to operate the site, analyse errors, and defend against attacks and abuse. The legal basis is Art. 6(1)(f) GDPR. The legitimate interest is the stability and security of the service. Log files are deleted automatically after 14 days.</p>\n<p>Pangolin retains HTTP request logs for 14 days, network logs for 30 days and authentication logs for 90 days. Processing serves secure operation and access control under Art. 6(1)(f) GDPR. Operator administrative actions are logged for 7 days.</p>\n<p>The application logs request identifiers, method, URL including parameters, hostname, IP address and port, response status and response time. Unexpected errors may be logged with diagnostic information and stack traces. Application handlers do not deliberately log request bodies or account profiles; Cookie and Authorization headers are redacted. Logs are Kubernetes container logs on the controller's infrastructure, without central log aggregation. Kubernetes rotates these logs by size (10 MiB per file, at most five files per container). No maximum time-based retention period is established. Logs are removed when the container is replaced.</p>\n<p>To limit uploads and login attempts, Schaffa stores a keyed hash of the IP address or a token ID together with a timestamp in SQLite. It does not store the plain IP for this purpose. The counting window is one hour. Entries older than one day are deleted only during a later successful rate-limit check. There is no scheduled deletion task. The purpose and legitimate interest are abuse prevention, under Art. 6(1)(f) GDPR. Backups are described in the account and content section.</p>",
    },
  },
  {
    id: "privacy-5",
    de: {
      title: "Schutz vor Angriffen (CrowdSec)",
      body: '<p>Zum Schutz vor Angriffen wertet die Sicherheitssoftware CrowdSec die Server-Logfiles automatisch aus und sperrt IP-Adressen, von denen erkennbar Angriffe ausgehen (zum Beispiel massenhafte Anmeldeversuche oder das Ausspähen von Schwachstellen). Erkennt CrowdSec einen Angriff, werden die IP-Adresse, der Zeitpunkt und die Art des Angriffs an die CrowdSec SAS, 20 rue Maurice Arnoux, 92120 Montrouge, Frankreich, übermittelt. CrowdSec nutzt diese Meldungen für eine gemeinsame Sperrliste, die Angriffe auf viele Server abwehrt. Bei normalem Surfen werden keine Daten an CrowdSec übermittelt.</p>\n<p>Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO. Das berechtigte Interesse liegt im Schutz der Website und ihrer Nutzer vor Angriffen.</p>\n<p>Für diese Verarbeitung sind der Verantwortliche und CrowdSec nach Angaben von CrowdSec gemeinsam verantwortlich (Art. 26 DSGVO): CrowdSec ist für den Betrieb seiner zentralen Dienste und Sperrlisten verantwortlich, der Verantwortliche für den Einsatz auf diesem Server. Sie können Ihre Rechte gegenüber beiden geltend machen, bei CrowdSec unter <a href="mailto:dpo@crowdsec.net">dpo@crowdsec.net</a>. CrowdSec kann die gemeldeten Daten an Mitglieder und Partner seines Netzwerks weitergeben. Übermittlungen in Länder außerhalb der EU erfolgen nach Angaben von CrowdSec auf Grundlage von Standardvertragsklauseln der EU-Kommission (Art. 46 Abs. 2 lit. c DSGVO).</p>\n<p>Vollständige IP-Adressen werden grundsätzlich höchstens drei Monate gespeichert und anschließend schrittweise verallgemeinert. Für bestimmte Angriffsanalysen und Trainingszwecke nennt CrowdSec Ausnahmen von bis zu einem Jahr vor der Anonymisierung. Details: <a href="https://www.crowdsec.net/privacy-policy">crowdsec.net/privacy-policy</a>.</p>\n<p>Lokal gespeicherte Angriffsmeldungen werden nach sieben Tagen gelöscht, bei mehr als 5.000 gespeicherten Meldungen auch früher; Meldungen zu einer noch aktiven Sperre bleiben bis zu deren Ende erhalten. Lokal verhängte Sperren gelten vier Stunden; aus der gemeinsamen Sperrliste übernommene Sperren können anders lange gelten. Datenbankeinträge abgelaufener Sperren werden mit der zugehörigen Angriffsmeldung gelöscht; abgelaufene Einträge ohne zugehörige Meldung entfernt die minütliche Bereinigung.</p>',
    },
    en: {
      title: "Protection against attacks (CrowdSec)",
      body: '<p>To protect against attacks, the security software CrowdSec automatically analyses the server log files and blocks IP addresses that are clearly the source of attacks (for example mass login attempts or scanning for vulnerabilities). When CrowdSec detects an attack, the IP address, time and type of attack are sent to CrowdSec SAS, 20 rue Maurice Arnoux, 92120 Montrouge, France. CrowdSec uses these reports for a shared blocklist that protects many servers. No data is sent to CrowdSec during normal browsing.</p>\n<p>The legal basis is Art. 6(1)(f) GDPR. The legitimate interest is protecting the website and its users from attacks.</p>\n<p>According to CrowdSec, the controller and CrowdSec are jointly responsible for this processing (Art. 26 GDPR): CrowdSec is responsible for operating its central services and blocklists, the controller for its use on this server. You can exercise your rights against either of them; CrowdSec can be reached at <a href="mailto:dpo@crowdsec.net">dpo@crowdsec.net</a>. CrowdSec may pass the reported data on to members and partners of its network. According to CrowdSec, transfers to countries outside the EU are based on the European Commission\'s Standard Contractual Clauses (Art. 46(2)(c) GDPR).</p>\n<p>Full IP addresses are generally retained for no more than three months and then progressively generalised. CrowdSec describes exceptions of up to one year before anonymisation for certain attack analyses and training purposes. Details: <a href="https://www.crowdsec.net/privacy-policy">crowdsec.net/privacy-policy</a>.</p>\n<p>Locally stored attack alerts are deleted after seven days, or earlier if more than 5,000 alerts are stored; alerts associated with an active block remain until it ends. Locally imposed blocks last four hours; blocks imported from the shared blocklist may have different durations. Database rows of expired blocks are deleted with their associated attack alert; the cleanup that runs every minute removes expired rows without an associated alert.</p>',
    },
  },
  {
    id: "privacy-6",
    de: {
      title: "Anmeldung (Single Sign-On)",
      body: "<p>Schaffa ist in Teilen nur nach Anmeldung zugänglich. Die Anmeldung erfolgt über den Reverse-Proxy Pangolin mit dem selbst betriebenen Identitätsdienst Pocket-ID auf der eigenen Infrastruktur. Dabei werden Benutzername, E-Mail-Adresse, Gruppenzugehörigkeit, Zeitpunkt der Anmeldung und IP-Adresse verarbeitet. Nach der Anmeldung setzt Pangolin ein Sitzungs-Cookie, das für den Zugang technisch erforderlich ist.</p>\n<p>Die Zugangskontrolle dient der Beschränkung der internen Verwaltung auf berechtigte eingeladene Personen. Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO. Für die Verwaltung verlangt Schaffa zusätzlich einen Admin-Token.</p>\n<p>Das Benutzerkonto in Pocket-ID und Pangolin besteht, solange der Zugang eingeräumt ist, und wird auf Anfrage oder nach Entzug des Zugangs gelöscht. Anmeldeprotokolle werden nach 90 Tagen gelöscht. Sicherungskopien werden nach spätestens drei Monaten überschrieben.</p>",
    },
    en: {
      title: "Sign-in (single sign-on)",
      body: "<p>Schaffa is partly accessible only after sign-in. Sign-in is handled by the Pangolin reverse proxy with Pocket-ID, an identity service self-hosted on the controller's infrastructure. This processes your user name, e-mail address, group membership, time of sign-in and IP address. After sign-in, Pangolin sets a session cookie that is technically required for access.</p>\n<p>Access control restricts internal administration to authorised invited people. The legal basis is Art. 6(1)(f) GDPR. Schaffa also requires an admin token for administration.</p>\n<p>The user account in Pocket-ID and Pangolin exists for as long as access is granted and is deleted on request or after access is revoked. Authentication logs are deleted after 90 days. Backups are overwritten after at most three months.</p>",
    },
  },
  {
    id: "privacy-7",
    de: {
      title: "Nutzerkonto und Inhalte",
      body: () =>
        `<p>Schaffa speichert für ein Konto eine lokale Benutzerkennung, die von Shoo für diese Website abgeleitete Kennung, soweit übermittelt E-Mail-Adresse, Name und Profilbild-URL, Erstellungs- und letzte Anmeldezeit sowie die Freigabe für interaktive Inhalte. Die Profilbild-URL wird gespeichert, aber im aktuellen Schaffa-Kontobereich nicht als externes Bild geladen. Sitzungen werden als schlüsselbasierte Hashes mit Benutzerzuordnung und Ablaufdatum gespeichert. Eine Kontositzung ist ${formatDuration(config.userSessionTtlHours * 3600, "de")} gültig; abgelaufene Datenbankeinträge werden bei einer späteren erfolgreichen Anmeldung entfernt. Abmelden löscht die aktuelle Sitzung.</p>\n<p>Agenten-Tokens werden mit Name, Berechtigungen, schlüsselbasiertem Hash, Kontozuordnung, Erstellungszeit, letzter Verwendung und Widerrufszeit gespeichert. Der geheime Agenten-Token wird nur bei der Erstellung angezeigt. Ein Widerruf verhindert die weitere Verwendung, entfernt aber nicht den Datenbankeintrag.</p>\n<p>Bei Uploads werden HTML, Dateien, Bilder, Videos, Präsentationen und gegebenenfalls deren PDF-, PowerPoint- und Markdown-Dateien gespeichert. Dazu gehören Titel, zufällige Kennungen, Dateityp, Größe, Hashwerte, Zeitpunkte, Scanstatus, Versionen und der veröffentlichende Token. Ursprüngliche Dateinamen werden bei Datei-Uploads durch generierte Namen ersetzt. Guides enthalten außerdem Sprache, Beschreibung, Ziel-URL, Schritte, Aktionstypen und -ziele, Prüfanweisungen, Screenshots, Bildunterschriften, gegebenenfalls eine Video-URL und unveränderliche JSON-, Markdown- und HTML-Stände. Screenshots und andere Inhalte können personenbezogene Daten der hochladenden Person und Dritter enthalten. Die Upload-Datensätze enthalten kein eigenes Feld für die IP-Adresse; Verbindungsdaten können in den oben beschriebenen Protokollen stehen.</p>\n<p>Veröffentlichte Inhalte einschließlich älterer veröffentlichter Versionen sind ohne Anmeldung für alle Personen erreichbar, die die URL kennen oder weitergegeben bekommen. Zufällige URLs sind kein Zugriffsschutz. Ein öffentliches Inhaltsverzeichnis wird nicht angeboten. Für veröffentlichte Inhalte besteht keine allgemeine Indexierungssperre. Suchmaschinen können Inhalte finden, wenn die URL bekannt wird. Entwürfe sind über die Verwaltungs-API nur für berechtigte Tokens zugänglich. Der Betreiber kann Inhalte zur Verwaltung und zur Bearbeitung von Löschanfragen einsehen.</p>\n<p>Anonyme HTML-Seiten sind ${formatDuration(config.anonymousPageTtlSeconds, "de")} öffentlich erreichbar. Ihre Daten werden grundsätzlich nach ${formatRetentionDays("de")} beim nächsten stündlichen oder beim Start ausgeführten Bereinigungslauf vom aktiven Speicher entfernt; bei Kapazitätsengpässen kann dies früher geschehen. Mit Token veröffentlichte Inhalte haben keine automatische Ablauffrist. HTML-Seiten behalten bis zu ${formatVersions("de")}, ältere Versionen werden bei weiteren Aktualisierungen entfernt. Bereits veröffentlichte Guide-Stände bleiben auch nach der Bearbeitung oder Entfernung einzelner Schritte unverändert.</p>\n<p>Seiten, einzelne Seitenversionen und Dateien können im Konto, mit dem veröffentlichenden Token über CLI/API oder durch den Administrator gelöscht werden. Guides können mit dem zugehörigen Token über CLI/API oder durch den Administrator gelöscht werden. Die vollständige Löschung einer Seite entfernt ihre Versionen und die zugehörigen aktiven und Quarantäne-Dateien. Die Löschung eines Guides entfernt seine Schritte, Revisionen und Guide-Bilder sowie sein Verzeichnis. Separat hochgeladene Videos, Präsentationsexporte und andere Dateien müssen separat gelöscht werden. Kopien, die andere Personen heruntergeladen oder zwischengespeichert haben, können nicht zurückgerufen werden.</p>\n<p>Eine Kontolöschung können Sie beim Betreiber anfordern. Sie entfernt das lokale Profil und seine Sitzungen und widerruft Agenten-Tokens. Token-Datensätze bleiben mit geändertem Namen ohne Kontozuordnung erhalten. Bereits veröffentlichte Inhalte bleiben bestehen und müssen gesondert gelöscht werden. Auch betroffene Dritte können die Entfernung sie betreffender Inhalte unter <a href="mailto:datenschutz-schaffa@heerlab.com">datenschutz-schaffa@heerlab.com</a> anfordern; bitte geben Sie die betroffene URL an.</p>\n<p>Die Verarbeitung auf eigener Infrastruktur in Deutschland dient der von Ihnen gewünschten Kontoführung, Veröffentlichung, Versionsverwaltung und Missbrauchsbearbeitung. Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO; das berechtigte Interesse liegt darin, diese Funktionen bereitzustellen und Veröffentlichungen sicher verwalten zu können.</p>\n<p>Die Datenbank und Dateien werden innerhalb der eigenen Infrastruktur in Deutschland gesichert. Sicherungskopien werden nach spätestens drei Monaten überschrieben. Gelöschte Kontodaten, Uploads und sonstige gelöschte Inhalte verschwinden daher nach spätestens etwa drei Monaten auch aus Sicherungen. Rechtsgrundlage für Wiederherstellung und Ausfallsicherheit ist Art. 6 Abs. 1 lit. f DSGVO.</p>\n<p>Konten bleiben bis zur Löschung auf Anfrage bestehen; eine automatische Löschung wegen Inaktivität gibt es nicht. Widerrufene Token-Datensätze haben keine automatische Löschfrist. Abgelaufene Sitzungszeilen werden erst bei einer späteren erfolgreichen Anmeldung entfernt, ältere Rate-Limit-Einträge erst bei einer späteren erfolgreichen Limit-Prüfung.</p>`,
    },
    en: {
      title: "User account and content",
      body: () =>
        `<p>For an account, Schaffa stores a local user ID, Shoo's identifier derived for this website, e-mail address, name and profile picture URL where supplied, creation and last login times, and permission to publish interactive content. The picture URL is stored but is not loaded as an external image in the current Schaffa account interface. Sessions are stored as keyed hashes with user associations and expiry dates. An account session is valid for ${formatDuration(config.userSessionTtlHours * 3600, "en")}; expired database rows are removed during a later successful login. Signing out deletes the current session.</p>\n<p>Agent tokens are stored with name, permissions, keyed hash, account association, creation, last use and revocation times. The secret agent token is shown only at creation. Revocation prevents further use but does not delete the database row.</p>\n<p>Uploads store HTML, files, images, videos, presentations and, where provided, their PDF, PowerPoint and Markdown files. Metadata includes titles, random IDs, file types, sizes, hashes, timestamps, scan states, versions and the publishing token. File uploads replace original filenames with generated names. Guides also contain language, description, target URL, steps, action types and targets, verification instructions, screenshots, captions, an optional video URL, and immutable JSON, Markdown and HTML snapshots. Screenshots and other content may include personal data about the uploader and third parties. Upload records have no dedicated IP address field; connection data can appear in the logs described above.</p>\n<p>Published content, including older published versions, is available without sign-in to anyone who knows or receives the URL. Random URLs are not access control. No public content directory is offered. Published content has no general indexing restriction. Search engines may discover content if its URL becomes known. Drafts are available through the management API only to authorised tokens. The operator can access content for administration and removal requests.</p>\n<p>Anonymous HTML pages are publicly available for ${formatDuration(config.anonymousPageTtlSeconds, "en")}. Their data is normally removed from active storage after ${formatRetentionDays("en")} at the next hourly or startup cleanup; capacity pressure may cause earlier removal. Token-authenticated publications have no automatic expiry. HTML pages retain up to ${formatVersions("en")}, with older versions removed on further updates. Published guide snapshots remain unchanged even when individual steps are edited or removed.</p>\n<p>Pages, individual page versions and files can be deleted through the account, by the publishing token through the CLI/API, or by the administrator. Guides can be deleted by their token through the CLI/API or by the administrator. Deleting a whole page removes its versions and associated active and quarantine files. Deleting a guide removes its steps, revisions, guide images and directory. Separately uploaded videos, presentation exports and other files must be deleted separately. Copies downloaded or cached by other people cannot be recalled.</p>\n<p>You can request account deletion from the operator. This removes the local profile and sessions and revokes agent tokens. Token records remain with a changed name and no account association. Published content remains available and must be deleted separately. Third parties can also request removal of content concerning them at <a href="mailto:datenschutz-schaffa@heerlab.com">datenschutz-schaffa@heerlab.com</a>; please include the affected URL.</p>\n<p>Processing on the controller's infrastructure in Germany provides the account, publication, version management and abuse handling you request. The legal basis is Art. 6(1)(f) GDPR; the legitimate interest is providing these functions and managing publications securely.</p>\n<p>The database and files are backed up within the controller's own infrastructure in Germany. Backups are overwritten after at most three months. Deleted account data, uploads and other deleted content therefore also disappear from backups after at most about three months. The legal basis for recovery and availability is Art. 6(1)(f) GDPR.</p>\n<p>Accounts remain until deletion on request; they are not automatically deleted for inactivity. Revoked token records have no automatic deletion period. Expired session rows are removed only during a later successful login, and older rate-limit entries only during a later successful limit check.</p>`,
    },
  },
  {
    id: "privacy-8",
    de: {
      title: "Anmeldedienste und Sicherheitsprüfung",
      body: '<p>Bereits beim Öffnen der Anmeldeseite /account lädt Ihr Browser das Skript https://shoo.dev/shoo.js vom extern betriebenen Dienst Shoo. Dadurch erhält Shoo Verbindungsdaten wie IP-Adresse und Browser-Kennung. Diese Shoo-Instanz wird nicht vom Schaffa-Betreiber selbst betrieben. Bei der von Ihnen gestarteten Anmeldung übermittelt der Browser die App-Herkunft, Weiterleitungsadresse und technische Werte für die abgesicherte Anmeldung, insbesondere PKCE-Challenge, Prüfwert, Statuskennung und Autorisierungscode. Shoo vermittelt die Anmeldung mit Google und gibt eine für Schaffa abgeleitete Kennung und ein signiertes Identitätstoken zurück. Schaffa fordert auch Profildaten an; Shoo beschreibt die Weitergabe von E-Mail-Adresse, Name und Profilbild als von Ihrer Freigabe abhängig. Der Server prüft das Token mit öffentlich von Shoo abgerufenen Signaturschlüsseln. Upload-Inhalte werden durch diese Anmeldung nicht an Shoo übermittelt.</p>\n<p>Zweck ist die von Ihnen gewünschte Anmeldung. Für die Kontoführung und Zugangssicherung bei Schaffa gilt Art. 6 Abs. 1 lit. f DSGVO. Die offizielle <a href="https://shoo.dev/privacy">Shoo-Datenschutzerklärung</a> nennt Google-Kennungen, optionale Profildaten, App- und Einwilligungsdatensätze sowie technische Sicherheitsdaten. Identitäts-, Profil- und App-Einwilligungsdaten bleiben dort bis zur Löschung gespeichert; Shoo bietet hierfür unter https://shoo.dev/me „Delete My Data“ an. Für kurzlebige Sicherheitsdaten nennt die Erklärung keine genauen Fristen. Datenschutzanfragen an Shoo sind laut dieser Erklärung an <a href="mailto:support@ping.gg">support@ping.gg</a> möglich.</p>\n<p>TODO(legal-shoo): Rechtsträger und Postanschrift von Shoo sowie der Mechanismus für mögliche Drittlandübermittlungen sind vom Betreiber noch zu klären. Shoos Infrastruktur-Empfänger und Verarbeitungsländer sind nicht verifiziert. Es wird keine Zertifizierung oder Vereinbarung für Shoo behauptet. Eine abschließende Bewertung der externen Dienste und der unbegrenzten Speicherung von shoo_identity steht aus.</p>\n<p>Google nennt für Nutzer im Europäischen Wirtschaftsraum die Google Ireland Limited, Gordon House, Barrow Street, Dublin 4, Irland. Google verarbeitet Anmelde- und technische Verbindungsdaten nach seiner eigenen <a href="https://policies.google.com/privacy?hl=de">Datenschutzerklärung</a>. Für globale Übermittlungen beschreibt Google das EU-US Data Privacy Framework und Standardvertragsklauseln, soweit anwendbar: <a href="https://policies.google.com/privacy/frameworks?hl=de">Übermittlungsrahmen</a>. Diese Angaben gelten nur für Google, nicht für Shoo. Für Daten bei Google gelten dessen Lösch- und Kontoeinstellungen. Während der Anmeldung zeigt Ihr Browser Seiten von Shoo an, die weitere Inhalte wie Schriftarten von Google laden können; dafür gilt die Datenschutzerklärung von Shoo. Schaffas eigene Seiten laden keine externen Schriftarten.</p>\n<p>Vor der Freigabe prüft der selbst betriebene Dienst ClamGate unter virus.heerlab.com Uploads auf Schadsoftware. Er erhält die vollständigen Prüfbytes und technische Prüfdaten wie Hashwert, Größe, Zufallskennung und Ergebnis; die Anwendung leitet die IP-Adresse des Uploaders nicht als Header weiter. Der Dienst läuft auf eigener Infrastruktur in Deutschland. Bilddateien werden zusätzlich lokal neu als WebP kodiert, wobei eingebettete Metadaten entfernt werden. Dies anonymisiert keine Personen oder Texte, die im Bild sichtbar sind. Zweck ist die Sicherheit der Veröffentlichung, Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO. Prüfbytes liegen in temporären Arbeitsbereichen, die von Sicherungen ausgeschlossen sind; Prüfmetadaten liegen auf einem persistenten Datenträger.</p>\n<p>ClamGate löscht die Prüfdatei beim Abschluss, Abbruch oder Fehlschlag des Auftrags. Ein Auftrag läuft nach einer Stunde ab; die Bereinigung läuft im Betrieb jede Sekunde und erneut beim Start. Fehlgeschlagene Dateilöschungen werden wiederholt. Temporäre Scanner-Arbeitsdateien werden nach der Prüfung beziehungsweise beim Stoppen der Scan-Engine entfernt. Auftragsmetadaten und signierte Ergebnisse laufen 24 Stunden nach Abschluss ab und werden bei der Bereinigung gelöscht, sobald die Dateilöschung erfolgreich war. Detaillierte Prüfstatistiken mit Dienst-IP-Adresse, Clientname, Anwendungskennung, Dateityp, Größe, Ergebnis und Zeitmessungen werden nach 30 Tagen bereinigt. Zusammengefasste Tagesstatistiken ohne IP-Adresse, Clientname oder Auftragskennung haben keine automatische Löschfrist. Ausfälle und Löschfehler können die Bereinigung verzögern. Sicherungen des Metadaten-Datenträgers verbleiben auf eigener Infrastruktur in Deutschland und werden nach spätestens drei Monaten überschrieben.</p>\n<p>ClamGate hat keine automatische HTTP-Anfrageprotokollierung aktiviert. Administrative Ereignisse wie die Unterbrechung der Annahme und der Abbruch eines Prüfauftrags werden mit Zeitpunkt und gegebenenfalls Auftragskennung in Containerlogs protokolliert. Dafür gilt die oben beschriebene größenbasierte Containerlog-Rotation; eine zeitliche Löschfrist ist nicht festgelegt.</p>\n<p>Die API-Dokumentation lädt Scalar aus der eigenen Anwendung, ohne dessen Telemetrie oder externe Standardschriftarten. Marp erstellt Präsentationen lokal in der CLI. Für diese Funktionen werden keine Inhalte an einen Scalar-, Marp-, KI- oder Mail-API-Dienst gesendet.</p>',
    },
    en: {
      title: "Sign-in services and security scanning",
      body: "<p>Opening the sign-in page /account already loads https://shoo.dev/shoo.js from the externally operated Shoo service. Shoo therefore receives connection data such as IP address and browser identifier. This Shoo instance is not self-hosted by Schaffa's operator. When you initiate sign-in, the browser sends the app origin, redirect URI and security values, including the PKCE challenge, verifier, state and authorisation code. Shoo brokers Google sign-in and returns an identifier derived for Schaffa and a signed identity token. Schaffa also requests profile data; Shoo describes sharing e-mail address, name and picture as dependent on your approval. The server verifies the token using public signing keys retrieved from Shoo. Uploaded content is not sent to Shoo through this sign-in.</p>\n<p>The purpose is the sign-in you request. Schaffa's account and access security processing relies on Art. 6(1)(f) GDPR. The official <a href=\"https://shoo.dev/privacy\">Shoo privacy policy</a> lists Google identifiers, optional profile data, app and consent records, and technical security data. Identity, profile and per-app consent records remain there until deletion; Shoo offers “Delete My Data” at https://shoo.dev/me. Its policy gives no exact periods for short-lived security records. That policy gives <a href=\"mailto:support@ping.gg\">support@ping.gg</a> as the contact for privacy requests to Shoo.</p>\n<p>TODO(legal-shoo): The operator must still establish Shoo's legal entity and postal address and the mechanism for any third-country transfers. Shoo's infrastructure recipients and processing countries have not been verified. No certification or agreement is claimed for Shoo. Assessment of the external services and unlimited shoo_identity storage remains outstanding.</p>\n<p>For users in the European Economic Area, Google identifies Google Ireland Limited, Gordon House, Barrow Street, Dublin 4, Ireland. Google processes sign-in and technical connection data under its own <a href=\"https://policies.google.com/privacy?hl=en\">privacy policy</a>. For global transfers, Google describes the EU-US Data Privacy Framework and Standard Contractual Clauses as applicable: <a href=\"https://policies.google.com/privacy/frameworks?hl=en\">transfer frameworks</a>. This information applies only to Google, not to Shoo. Google's deletion and account settings govern data held by Google. During sign-in, your browser displays Shoo pages that may load further content such as fonts from Google; Shoo's privacy policy applies to this. Schaffa's own pages do not load external fonts.</p>\n<p>Before publication, the self-hosted ClamGate service at virus.heerlab.com scans uploads for malware. It receives the full bytes to scan and technical scan data such as hash, size, nonce and result; the application does not forward the uploader's IP address in a header. The service runs on the controller's infrastructure in Germany. Images are also re-encoded locally as WebP, stripping embedded metadata. This does not anonymise people or text visible in an image. The purpose is secure publication under Art. 6(1)(f) GDPR. Scan payloads occupy temporary workspaces excluded from backups; scan metadata is held on persistent storage.</p>\n<p>ClamGate deletes the scan payload when a job finishes, is cancelled or fails. A job expires after one hour; cleanup runs every second while the service operates and again at startup. Failed file deletions are retried. Temporary scanner working files are removed after scanning or when the scan engine stops. Job metadata and signed results expire 24 hours after completion and are deleted during cleanup once file deletion has succeeded. Detailed scan statistics, including service IP address, client name, application ID, file type, size, outcome and timings, are pruned after 30 days. Aggregate daily statistics without IP addresses, client names or job identifiers have no automatic deletion period. Outages and deletion failures can delay cleanup. Backups of the metadata volume remain on the controller's own infrastructure in Germany and are overwritten after at most three months.</p>\n<p>ClamGate has automatic HTTP request logging disabled. Administrative events such as pausing intake and cancelling a scan are logged with a timestamp and, where applicable, a job identifier in container logs. The size-based container log rotation described above applies; no time-based deletion deadline is established.</p>\n<p>The API documentation loads Scalar from the application itself, without its telemetry or external default fonts. Marp generates presentations locally in the CLI. These functions do not send content to a Scalar, Marp, AI or mail API service.</p>",
    },
  },
  {
    id: "privacy-9",
    de: {
      title: "Kontakt per E-Mail",
      body: '<p>Wenn Sie per E-Mail Kontakt aufnehmen, werden Ihre E-Mail-Adresse, der Inhalt Ihrer Nachricht und die technischen Angaben der E-Mail verarbeitet, um Ihre Anfrage zu beantworten. Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO. Das berechtigte Interesse liegt darin, Anfragen beantworten zu können.</p>\n<p>Die E-Mail-Postfächer werden bei der Fastmail Pty Ltd, PO Box 234, Collins Street West, VIC 8007, Australien, als Auftragsverarbeiter betrieben. Dabei können Daten in Länder außerhalb der EU übermittelt werden, insbesondere nach Australien, in die USA und nach Indien. Für diese Übermittlungen verwendet Fastmail Standardvertragsklauseln der EU-Kommission (Art. 46 Abs. 2 lit. c DSGVO). Details: <a href="https://www.fastmail.com/policies/privacy/">Datenschutzerklärung von Fastmail</a>, <a href="https://www.fastmail.com/policies/dpa/">Auftragsverarbeitungsvertrag</a> und <a href="https://www.fastmail.com/policies/dpa/section3/">Standardvertragsklauseln</a>. Eine Kopie der Garantien erhalten Sie auf Anfrage an <a href="mailto:datenschutz-schaffa@heerlab.com">datenschutz-schaffa@heerlab.com</a>.</p>\n<p>Der Verantwortliche löscht Nachrichten nach Erledigung der Anfrage, soweit keine Aufbewahrung erforderlich ist. Bei Fastmail können anschließend noch Sicherungs- und Protokolldaten nach dessen veröffentlichten Löschregeln verbleiben.</p>',
    },
    en: {
      title: "Contact by e-mail",
      body: '<p>If you contact us by e-mail, your e-mail address, the content of your message and the technical details of the e-mail are processed to answer your request. The legal basis is Art. 6(1)(f) GDPR. The legitimate interest is being able to answer requests.</p>\n<p>The mailboxes are hosted by Fastmail Pty Ltd, PO Box 234, Collins Street West, VIC 8007, Australia, as a processor. Data may be transferred to countries outside the EU, in particular Australia, the USA and India. For these transfers, Fastmail uses the European Commission\'s Standard Contractual Clauses (Art. 46(2)(c) GDPR). Details: <a href="https://www.fastmail.com/policies/privacy/">Fastmail privacy policy</a>, <a href="https://www.fastmail.com/policies/dpa/">data processing agreement</a> and <a href="https://www.fastmail.com/policies/dpa/section3/">Standard Contractual Clauses</a>. You can obtain a copy of the safeguards by writing to <a href="mailto:datenschutz-schaffa@heerlab.com">datenschutz-schaffa@heerlab.com</a>.</p>\n<p>The controller deletes messages after dealing with the request unless retention remains necessary. Fastmail may subsequently retain backup and log data under its published deletion rules.</p>',
    },
  },
  {
    id: "privacy-10",
    de: {
      title: "Cookies und lokale Speicherung",
      body: () =>
        `<p>Solange Sie sich nicht anmelden, setzt Schaffa keine Cookies und legt keine Daten im Browserspeicher ab. Bei einer Anmeldung werden folgende Einträge verwendet:</p>\n<ul><li>__Secure-schaffa_user: Schaffa, HttpOnly-Sitzungs-Cookie unter /account, ${formatDuration(config.userSessionTtlHours * 3600, "de")}.</li><li>__Secure-schaffa_admin: Schaffa, HttpOnly-Admin-Cookie unter /admin, acht Stunden. Der zugrunde liegende Token bleibt bis zum Widerruf gültig.</li><li>localStorage shoo_identity: Shoo-Skript auf Schaffas Herkunft; Identitätstoken, Kennung und Ablaufmetadaten. Der Eintrag bleibt gespeichert, bis Sie sich über Schaffa abmelden oder den Browserspeicher löschen.</li><li>sessionStorage shoo_pkce: Prüfwert und Status der abgesicherten Anmeldung; beim Callback entfernt, andernfalls bis zum Ende der Tab-Sitzung.</li><li>sessionStorage shoo_return_to: Rücksprungziel; beim Callback verbraucht, andernfalls bis zum Ende der Tab-Sitzung.</li><li>shoo_session auf shoo.dev: laut Shoo ein signiertes HttpOnly-Anmelde-Cookie. Die Speicherdauer legt Shoo fest.</li><li>Pangolin und Pocket-ID: Sitzungs-Cookies für die Anmeldung zur internen Verwaltung (nur eingeladene Personen, siehe Abschnitt 6).</li></ul>\n<p>Die Schaffa-Sitzungen und Anmelde-Prüfwerte dienen dem ausdrücklich gewünschten Zugang und sind technisch erforderlich im Sinne von § 25 Abs. 2 Nr. 2 TDDDG. Die Verarbeitung für die Zugangssicherung erfolgt auf Grundlage von Art. 6 Abs. 1 lit. f DSGVO.</p>`,
    },
    en: {
      title: "Cookies and local storage",
      body: () =>
        `<p>Until you sign in, Schaffa does not set cookies or store data in your browser. Signing in uses the following entries:</p>\n<ul><li>__Secure-schaffa_user: Schaffa HttpOnly session cookie at /account, ${formatDuration(config.userSessionTtlHours * 3600, "en")}.</li><li>__Secure-schaffa_admin: Schaffa HttpOnly admin cookie at /admin, eight hours. The underlying token remains valid until revoked.</li><li>localStorage shoo_identity: Shoo script on Schaffa's origin; identity token, identifier and expiry metadata. The entry remains stored until you sign out through Schaffa or clear your browser storage.</li><li>sessionStorage shoo_pkce: sign-in verifier and state; removed on callback, otherwise lasts for the tab session.</li><li>sessionStorage shoo_return_to: return destination; consumed on callback, otherwise lasts for the tab session.</li><li>shoo_session on shoo.dev: a signed HttpOnly login cookie according to Shoo. Shoo determines the retention period.</li><li>Pangolin and Pocket-ID: session cookies for signing in to internal administration (invited people only, see section 6).</li></ul>\n<p>Schaffa sessions and sign-in verifiers support the explicitly requested access and are technically necessary under Section 25(2) no. 2 TDDDG. Access security processing relies on Art. 6(1)(f) GDPR.</p>`,
    },
  },
  {
    id: "privacy-11",
    de: {
      title: "Ihre Rechte",
      body: '<p>Sie haben gegenüber dem Verantwortlichen folgende Rechte hinsichtlich Ihrer personenbezogenen Daten:</p>\n<ul><li>Auskunft (Art. 15 DSGVO)</li><li>Berichtigung (Art. 16 DSGVO)</li><li>Löschung (Art. 17 DSGVO)</li><li>Einschränkung der Verarbeitung (Art. 18 DSGVO)</li><li>Datenübertragbarkeit (Art. 20 DSGVO)</li><li>Widerruf einer erteilten Einwilligung (Art. 7 Abs. 3 DSGVO): Sie können eine erteilte Einwilligung jederzeit widerrufen. Die Rechtmäßigkeit der Verarbeitung vor dem Widerruf bleibt unberührt.</li></ul>\n<p><strong>Widerspruchsrecht (Art. 21 DSGVO):</strong> Soweit eine Verarbeitung auf Art. 6 Abs. 1 lit. f DSGVO beruht, können Sie aus Gründen, die sich aus Ihrer besonderen Situation ergeben, jederzeit widersprechen.</p>\n<p>Zur Ausübung Ihrer Rechte genügt eine Nachricht an <a href="mailto:datenschutz-schaffa@heerlab.com">datenschutz-schaffa@heerlab.com</a>.</p>\n<p>Sie haben außerdem das Recht, sich bei einer Datenschutz-Aufsichtsbehörde zu beschweren, insbesondere in dem Mitgliedstaat Ihres gewöhnlichen Aufenthalts, Ihres Arbeitsplatzes oder des Orts des mutmaßlichen Verstoßes (Art. 77 DSGVO).</p>',
    },
    en: {
      title: "Your rights",
      body: '<p>You have the following rights regarding your personal data:</p>\n<ul><li>access (Art. 15 GDPR)</li><li>rectification (Art. 16 GDPR)</li><li>erasure (Art. 17 GDPR)</li><li>restriction of processing (Art. 18 GDPR)</li><li>data portability (Art. 20 GDPR)</li><li>withdrawal of consent (Art. 7(3) GDPR): you may withdraw consent at any time. Withdrawal does not affect the lawfulness of processing before withdrawal.</li></ul>\n<p><strong>Right to object (Art. 21 GDPR):</strong> Where processing is based on Art. 6(1)(f) GDPR, you may object at any time on grounds relating to your particular situation.</p>\n<p>To exercise your rights, simply send a message to <a href="mailto:datenschutz-schaffa@heerlab.com">datenschutz-schaffa@heerlab.com</a>.</p>\n<p>You also have the right to lodge a complaint with a data protection supervisory authority, in particular in the member state of your habitual residence, place of work or place of the alleged infringement (Art. 77 GDPR).</p>',
    },
  },
  {
    id: "privacy-12",
    de: {
      title: "Pflicht zur Bereitstellung",
      body: "<p>Sie sind nicht verpflichtet, personenbezogene Daten bereitzustellen. Ohne die technisch notwendigen Verbindungsdaten kann die Website jedoch nicht ausgeliefert werden, und ohne Anmeldung sind die geschützten Bereiche nicht nutzbar.</p>",
    },
    en: {
      title: "Obligation to provide data",
      body: "<p>You are not obliged to provide personal data. However, the website cannot be delivered without the technically necessary connection data, and the protected areas cannot be used without signing in.</p>",
    },
  },
  {
    id: "privacy-13",
    de: {
      title: "Änderungen",
      body: "<p>Diese Datenschutzerklärung wird angepasst, wenn sich die Website oder die Rechtslage ändert. Es gilt die jeweils hier veröffentlichte Fassung.</p>",
    },
    en: {
      title: "Changes",
      body: "<p>This privacy policy is updated when the website or the legal situation changes. The version published here applies.</p>",
    },
  },
];

export const legalRoutes = ["/impressum", "/datenschutz", "/legal-notice", "/privacy"] as const;
export type LegalRoute = (typeof legalRoutes)[number];

interface LegalPageDefinition {
  language: Language;
  title: string;
  counterpart: LegalRoute;
  privacy: boolean;
  sections: LegalSection[];
}

const pageDefinitions: Record<LegalRoute, LegalPageDefinition> = {
  "/impressum": {
    language: "de",
    title: "Impressum",
    counterpart: "/legal-notice",
    privacy: false,
    sections: noticeSections,
  },
  "/legal-notice": {
    language: "en",
    title: "Legal Notice (Impressum)",
    counterpart: "/impressum",
    privacy: false,
    sections: noticeSections,
  },
  "/datenschutz": {
    language: "de",
    title: "Datenschutzerklärung",
    counterpart: "/privacy",
    privacy: true,
    sections: privacySections,
  },
  "/privacy": {
    language: "en",
    title: "Privacy Policy",
    counterpart: "/datenschutz",
    privacy: true,
    sections: privacySections,
  },
};

export function renderLegalPage(route: LegalRoute): string {
  const page = pageDefinitions[route];
  const german = page.language === "de";
  const otherLanguage = german ? "en" : "de";
  const languageLabel = german ? "English" : "Deutsch";
  const dateLabel = german ? "Stand" : "Last updated";
  const updated = page.privacy ? `<p class="updated">${dateLabel}: 2026-10-21</p>` : "";
  const body = page.sections
    .map((section, index) =>
      renderSection(section, page.language, page.privacy ? `${String(index + 1)}. ` : ""),
    )
    .join("\n");
  return `<!doctype html>
<html lang="${page.language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><link rel="icon" href="data:,"><title>${page.title} · Schaffa</title><style>${legalStyles}${legalFooterStyles}</style></head><body>
<header><a class="wordmark" href="/">Schaffa</a><a href="${page.counterpart}" lang="${otherLanguage}" hreflang="${otherLanguage}">${languageLabel}</a></header>
<main><h1>${page.title}</h1>${updated}
${body}
</main>${legalFooter(page.language)}</body></html>`;
}

function renderSection(section: LegalSection, language: Language, prefix: string): string {
  const text = language === "de" ? section.de : section.en;
  const body = typeof text.body === "function" ? text.body() : text.body;
  return `<section id="${section.id}" aria-labelledby="${section.id}-heading"><h2 id="${section.id}-heading">${prefix}${text.title}</h2>${body}</section>`;
}

const legalStyles = `:root{font-family:"Avenir Next","Segoe UI",sans-serif;color:#20211e;background:#f3f0e8}*{box-sizing:border-box}body{margin:0;line-height:1.7}header{max-width:980px;margin:auto;padding:24px;display:flex;align-items:center;justify-content:space-between;border-bottom:2px solid #20211e;gap:24px}.wordmark{font:700 28px Georgia,serif;text-decoration:none;color:#20211e}a{color:#8c321c;text-underline-offset:4px;overflow-wrap:anywhere}a:focus-visible{outline:3px solid #a43f24;outline-offset:4px}main{max-width:820px;margin:auto;padding:40px 24px 72px;overflow-wrap:anywhere}h1,h2{font-family:Georgia,"Times New Roman",serif;line-height:1.15;letter-spacing:-.025em}h1{font-size:clamp(34px,6vw,56px);margin:0 0 20px}h2{font-size:26px;margin:0 0 18px}section{padding-top:32px;margin-top:28px;border-top:1px solid #cbc5b8}p{margin:0 0 18px}ul{padding-left:24px}.updated{color:#696961;font-size:14px}@media(max-width:480px){header{padding:20px}main{padding:32px 20px 56px}h2{font-size:23px}}`;
