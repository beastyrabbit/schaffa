import { legalFooter, legalFooterStyles } from "./legal-footer.js";

type Language = "de" | "en";

interface SectionText {
  title: string;
  body: string;
}

interface LegalSection {
  id: string;
  de: SectionText;
  en: SectionText;
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
      body: "<p>Schaffa läuft auf eigener Server-Infrastruktur des Verantwortlichen in Deutschland. Aufrufe aus dem Internet erreichen die Anwendung über einen Reverse-Proxy auf einem virtuellen Server der netcup GmbH, Emmy-Noether-Straße 10, 76131 Karlsruhe, Deutschland (Rechenzentrum in Nürnberg). netcup verarbeitet die Daten dabei als Auftragsverarbeiter; mit netcup besteht ein Vertrag zur Auftragsverarbeitung nach Art. 28 DSGVO. Die Verbindung ist bis zum Reverse-Proxy TLS-verschlüsselt und wird von dort durch einen verschlüsselten Tunnel an die eigene Infrastruktur weitergeleitet.</p>\n<p>Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO. Das berechtigte Interesse liegt in einer sicheren und zuverlässigen Bereitstellung der Website.</p>\n<p>Zur Datensicherung werden regelmäßig Sicherungskopien innerhalb der eigenen Infrastruktur erstellt; sie werden nach Ablauf ihrer Aufbewahrungszeit überschrieben.</p>",
    },
    en: {
      title: "Hosting and delivery",
      body: "<p>Schaffa runs on the controller's own server infrastructure in Germany. Requests from the internet reach the application through a reverse proxy on a virtual server operated by netcup GmbH, Emmy-Noether-Straße 10, 76131 Karlsruhe, Germany (data center in Nuremberg). netcup processes the data as a processor under a data processing agreement pursuant to Art. 28 GDPR. The connection is TLS-encrypted up to the reverse proxy and forwarded from there to the controller's infrastructure through an encrypted tunnel.</p>\n<p>The legal basis is Art. 6(1)(f) GDPR. The legitimate interest is the secure and reliable provision of the website.</p>\n<p>To back up data, backups are regularly created within the controller's own infrastructure; they are overwritten after their retention period has elapsed.</p>",
    },
  },
  {
    id: "privacy-4",
    de: {
      title: "Server-Logfiles",
      body: "<p>Bei jedem Aufruf speichert der Reverse-Proxy automatisch folgende Daten:</p>\n<ul><li>IP-Adresse des anfragenden Geräts</li><li>Datum und Uhrzeit des Zugriffs</li><li>aufgerufene Adresse (Pfad einschließlich Parameter), HTTP-Methode und Protokoll</li><li>HTTP-Statuscode, übertragene Datenmenge und Antwortzeit</li><li>Browser-Kennung (User-Agent)</li><li>verwendete TLS-Version und Verschlüsselung</li><li>angesprochener Dienst</li></ul>\n<p>Die Header Cookie und Authorization werden geschwärzt. URL-Pfade und Abfrageparameter werden protokolliert.</p>\n<p>Die Daten dienen dem Betrieb, der Fehleranalyse und der Abwehr von Angriffen und Missbrauch. Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO. Das berechtigte Interesse liegt in Stabilität und Sicherheit des Angebots. Die Logfiles werden nach 14 Tagen automatisch gelöscht.</p>\n<p>Pangolin speichert HTTP-Anfrageprotokolle für 14 Tage, Netzwerkprotokolle für 30 Tage und Anmeldeprotokolle für 90 Tage. Kurzlebige Anwendungs-Containerlogs enthalten Verbindungsdaten wie IP-Adresse, URL und Antwortstatus und werden bei Größenrotation oder beim Ersetzen des Containers gelöscht. CrowdSec speichert lokale Angriffsmeldungen nur kurz, in der Regel sieben Tage. Diese Verarbeitung dient dem sicheren Betrieb, der Fehleranalyse und der Zugangskontrolle auf Grundlage von Art. 6 Abs. 1 lit. f DSGVO.</p>",
    },
    en: {
      title: "Server log files",
      body: "<p>For every request, the reverse proxy automatically stores the following data:</p>\n<ul><li>IP address of the requesting device</li><li>date and time of access</li><li>requested address (path including parameters), HTTP method and protocol</li><li>HTTP status code, amount of data transferred, and response time</li><li>browser identifier (user agent)</li><li>TLS version and cipher used</li><li>target service</li></ul>\n<p>The Cookie and Authorization headers are redacted. URL paths and query parameters are logged.</p>\n<p>This data is used to operate the site, analyse errors, and defend against attacks and abuse. The legal basis is Art. 6(1)(f) GDPR. The legitimate interest is the stability and security of the service. Log files are deleted automatically after 14 days.</p>\n<p>Pangolin retains HTTP request logs for 14 days, network logs for 30 days and authentication logs for 90 days. Short-lived application container logs contain connection data such as IP address, URL and response status and are deleted during size-based rotation or when the container is replaced. CrowdSec retains local attack alerts only briefly, generally for seven days. This processing serves secure operation, error analysis and access control under Art. 6(1)(f) GDPR.</p>",
    },
  },
  {
    id: "privacy-5",
    de: {
      title: "Schutz vor Angriffen (CrowdSec)",
      body: '<p>Zum Schutz vor Angriffen wertet die Sicherheitssoftware CrowdSec die Server-Logfiles automatisch aus und sperrt IP-Adressen, von denen erkennbar Angriffe ausgehen (zum Beispiel massenhafte Anmeldeversuche oder das Ausspähen von Schwachstellen). Erkennt CrowdSec einen Angriff, werden die IP-Adresse, der Zeitpunkt und die Art des Angriffs an die CrowdSec SAS, 20 rue Maurice Arnoux, 92120 Montrouge, Frankreich, übermittelt. CrowdSec nutzt diese Meldungen für eine gemeinsame Sperrliste, die Angriffe auf viele Server abwehrt. Bei normalem Surfen werden keine Daten an CrowdSec übermittelt.</p>\n<p>Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO. Das berechtigte Interesse liegt im Schutz der Website und ihrer Nutzer vor Angriffen.</p>\n<p>Für diese Verarbeitung sind der Verantwortliche und CrowdSec nach Angaben von CrowdSec gemeinsam verantwortlich (Art. 26 DSGVO): CrowdSec ist für den Betrieb seiner zentralen Dienste und Sperrlisten verantwortlich, der Verantwortliche für den Einsatz auf diesem Server. Sie können Ihre Rechte gegenüber beiden geltend machen, bei CrowdSec unter <a href="mailto:dpo@crowdsec.net">dpo@crowdsec.net</a>. CrowdSec kann die gemeldeten Daten an Mitglieder und Partner seines Netzwerks weitergeben. Übermittlungen in Länder außerhalb der EU erfolgen nach Angaben von CrowdSec auf Grundlage von Standardvertragsklauseln der EU-Kommission (Art. 46 Abs. 2 lit. c DSGVO).</p>\n<p>Vollständige IP-Adressen werden grundsätzlich höchstens drei Monate gespeichert und anschließend schrittweise verallgemeinert. Für bestimmte Angriffsanalysen und Trainingszwecke nennt CrowdSec Ausnahmen von bis zu einem Jahr vor der Anonymisierung. Details: <a href="https://www.crowdsec.net/privacy-policy">crowdsec.net/privacy-policy</a>.</p>',
    },
    en: {
      title: "Protection against attacks (CrowdSec)",
      body: '<p>To protect against attacks, the security software CrowdSec automatically analyses the server log files and blocks IP addresses that are clearly the source of attacks (for example mass login attempts or scanning for vulnerabilities). When CrowdSec detects an attack, the IP address, time and type of attack are sent to CrowdSec SAS, 20 rue Maurice Arnoux, 92120 Montrouge, France. CrowdSec uses these reports for a shared blocklist that protects many servers. No data is sent to CrowdSec during normal browsing.</p>\n<p>The legal basis is Art. 6(1)(f) GDPR. The legitimate interest is protecting the website and its users from attacks.</p>\n<p>According to CrowdSec, the controller and CrowdSec are jointly responsible for this processing (Art. 26 GDPR): CrowdSec is responsible for operating its central services and blocklists, the controller for its use on this server. You can exercise your rights against either of them; CrowdSec can be reached at <a href="mailto:dpo@crowdsec.net">dpo@crowdsec.net</a>. CrowdSec may pass the reported data on to members and partners of its network. According to CrowdSec, transfers to countries outside the EU are based on the European Commission\'s Standard Contractual Clauses (Art. 46(2)(c) GDPR).</p>\n<p>Full IP addresses are generally retained for no more than three months and then progressively generalised. CrowdSec describes exceptions of up to one year before anonymisation for certain attack analyses and training purposes. Details: <a href="https://www.crowdsec.net/privacy-policy">crowdsec.net/privacy-policy</a>.</p>',
    },
  },
  {
    id: "privacy-6",
    de: {
      title: "Anmeldung (Single Sign-On)",
      body: "<p>Schaffa ist in Teilen nur nach Anmeldung zugänglich. Die Anmeldung erfolgt über den Reverse-Proxy Pangolin mit dem selbst betriebenen Identitätsdienst Pocket-ID auf der eigenen Infrastruktur. Dabei werden Benutzername, E-Mail-Adresse, Gruppenzugehörigkeit, Zeitpunkt der Anmeldung und IP-Adresse verarbeitet. Nach der Anmeldung setzt Pangolin ein Sitzungs-Cookie, das für den Zugang technisch erforderlich ist.</p>\n<p>Die Zugangskontrolle dient der Beschränkung der internen Verwaltung auf berechtigte eingeladene Personen. Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO. Für die Verwaltung verlangt Schaffa zusätzlich einen Admin-Token.</p>\n<p>Das Benutzerkonto in Pocket-ID und Pangolin besteht, solange der Zugang eingeräumt ist, und wird auf Anfrage oder nach Entzug des Zugangs gelöscht. Anmeldeprotokolle werden nach 90 Tagen gelöscht.</p>",
    },
    en: {
      title: "Sign-in (single sign-on)",
      body: "<p>Schaffa is partly accessible only after sign-in. Sign-in is handled by the Pangolin reverse proxy with Pocket-ID, an identity service self-hosted on the controller's infrastructure. This processes your user name, e-mail address, group membership, time of sign-in and IP address. After sign-in, Pangolin sets a session cookie that is technically required for access.</p>\n<p>Access control restricts internal administration to authorised invited people. The legal basis is Art. 6(1)(f) GDPR. Schaffa also requires an admin token for administration.</p>\n<p>The user account in Pocket-ID and Pangolin exists for as long as access is granted and is deleted on request or after access is revoked. Authentication logs are deleted after 90 days.</p>",
    },
  },
  {
    id: "privacy-7",
    de: {
      title: "Nutzerkonto und Inhalte",
      body: '<p>Schaffa speichert Kontokennungen und optionale Profildaten aus der Anmeldung, Sitzungen und Agenten-Tokens sowie hochgeladene Seiten, Dateien, Guides und Präsentationen einschließlich Versionen und Metadaten. Inhalte können personenbezogene Daten der hochladenden Person und Dritter enthalten. Die Verarbeitung erfolgt auf eigener Infrastruktur in Deutschland zur Kontoführung, Veröffentlichung und sicheren Verwaltung der Inhalte. Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO; das berechtigte Interesse liegt in der Bereitstellung dieser Funktionen und der Missbrauchsabwehr.</p>\n<p>Veröffentlichte Inhalte und ihre veröffentlichten Versionen sind für alle Personen erreichbar, die den Link kennen. Es gibt kein öffentliches Inhaltsverzeichnis; Links sind kein Zugriffsschutz. Der Betreiber kann Inhalte zur Verwaltung und zur Bearbeitung von Löschanfragen einsehen.</p>\n<p>Eigene Seiten und Dateien können im Konto oder mit dem zugehörigen Token über CLI/API gelöscht werden, Guides mit dem zugehörigen Token über CLI/API. Der Administrator kann diese Inhalte ebenfalls löschen. Einzelne Seitenversionen können nur im Konto oder durch den Administrator gelöscht werden. Veröffentlichte Guide-Versionen bleiben auch nach dem Entfernen einzelner Schritte erhalten. Separat hochgeladene Dateien müssen separat gelöscht werden. Agenten-Tokens können widerrufen werden; ihre Datensätze bleiben dabei erhalten. Eine Kontolöschung kann beim Betreiber angefordert werden; sie entfernt das Profil und die Sitzungen und widerruft die Tokens, löscht aber keine veröffentlichten Inhalte. Betroffene Dritte können die Entfernung sie betreffender Inhalte unter <a href="mailto:datenschutz-schaffa@heerlab.com">datenschutz-schaffa@heerlab.com</a> anfordern, bitte mit der betroffenen URL. Bereits heruntergeladene oder zwischengespeicherte Kopien können nicht zurückgerufen werden.</p>\n<p>Anonyme Seiten laufen nach kurzer Zeit automatisch ab und werden automatisch gelöscht. Konten, Token-Datensätze und nicht selbst gelöschte veröffentlichte Inhalte werden bis zur Löschung, längstens bis zu 10 Jahre gespeichert.</p>',
    },
    en: {
      title: "User account and content",
      body: '<p>Schaffa stores account identifiers and optional profile data from sign-in, sessions and agent tokens, as well as uploaded pages, files, guides and presentations including versions and metadata. Content may contain personal data about the uploader and third parties. Processing takes place on the controller\'s own infrastructure in Germany to provide accounts, publication and secure content management. The legal basis is Art. 6(1)(f) GDPR; the legitimate interest is providing these functions and preventing abuse.</p>\n<p>Published content and its published versions are accessible to anyone who knows the link. There is no public content directory; links are not access protection. The operator can access content for administration and removal requests.</p>\n<p>You can delete your own pages and files through the account or with the owning token through the CLI/API, and guides with the owning token through the CLI/API. The administrator can also delete this content. Individual page versions can only be deleted through the account or by the administrator. Published guide versions remain even after individual steps are removed. Separately uploaded files must be deleted separately. Agent tokens can be revoked; their records remain. Account deletion can be requested from the operator; it removes the profile and sessions and revokes tokens, but does not delete published content. Affected third parties can request removal of content concerning them at <a href="mailto:datenschutz-schaffa@heerlab.com">datenschutz-schaffa@heerlab.com</a>, including the affected URL. Copies already downloaded or cached cannot be recalled.</p>\n<p>Anonymous pages expire automatically after a short time and are automatically deleted. Accounts, token records and published content you have not deleted are stored until deleted, at most up to 10 years.</p>',
    },
  },
  {
    id: "privacy-8",
    de: {
      title: "Anmeldung über Shoo",
      body: '<p>Beim Öffnen der Anmeldeseite lädt Ihr Browser ein Skript des externen Dienstes Shoo (shoo.dev), der die Anmeldung mit Google vermittelt. Shoo und Google erhalten Verbindungsdaten und bei der Anmeldung die Google-Kontokennung sowie optional E-Mail-Adresse, Name und Profilbild. Schaffa erhält eine Kennung und die optionalen Profildaten. Zweck ist die von Ihnen gewünschte Anmeldung und Zugangssicherung auf Grundlage von Art. 6 Abs. 1 lit. f DSGVO. Angaben zu den Anbietern und möglichen Drittlandübermittlungen finden Sie in der <a href="https://shoo.dev/privacy">Datenschutzerklärung von Shoo</a>, Kontakt <a href="mailto:support@ping.gg">support@ping.gg</a>, und der <a href="https://policies.google.com/privacy?hl=de">Datenschutzerklärung von Google</a>. Für den Europäischen Wirtschaftsraum ist Google Ireland Limited zuständig.</p>',
    },
    en: {
      title: "Sign-in via Shoo",
      body: '<p>Opening the sign-in page loads a script from the external service Shoo (shoo.dev), which brokers sign-in with Google. Shoo and Google receive connection data and, on sign-in, the Google account identity and optionally e-mail address, name and picture. Schaffa receives an identifier and the optional profile data. The purpose is the sign-in and access security you request under Art. 6(1)(f) GDPR. For provider details and possible third-country transfers, see <a href="https://shoo.dev/privacy">Shoo\'s privacy policy</a>, contact <a href="mailto:support@ping.gg">support@ping.gg</a>, and <a href="https://policies.google.com/privacy?hl=en">Google\'s privacy policy</a>. Google Ireland Limited is responsible for the European Economic Area.</p>',
    },
  },
  {
    id: "privacy-scan",
    de: {
      title: "Sicherheitsprüfung von Uploads",
      body: "<p>Uploads werden vor der Veröffentlichung durch den selbst betriebenen Dienst ClamGate auf eigener Infrastruktur auf Schadsoftware untersucht; die Prüfdaten werden nach der Prüfung, die Ergebnisse nach kurzer Zeit gelöscht. Bilder werden neu kodiert, um eingebettete Metadaten zu entfernen; dies dient der sicheren Veröffentlichung auf Grundlage von Art. 6 Abs. 1 lit. f DSGVO.</p>",
    },
    en: {
      title: "Upload security scanning",
      body: "<p>Before publication, uploads are scanned for malware by the self-hosted ClamGate service on the controller's own infrastructure; scan data is deleted after the scan and results after a short time. Images are re-encoded to remove embedded metadata; this serves secure publication under Art. 6(1)(f) GDPR.</p>",
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
      title: "Reichweitenmessung und Fehlerüberwachung",
      body: "<p>Umami wird vom Betreiber in Deutschland selbst gehostet. Erst nach Ihrer Einwilligung im Cookie-Banner erfasst Umami Besuche, Interaktionen und Leistung sowie maskierte Sitzungsaufzeichnungen und Heatmaps auf Schaffas eigenen Seiten, nicht auf veröffentlichten Inhalten. Rechtsgrundlage sind Art. 6 Abs. 1 lit. a DSGVO und § 25 Abs. 1 TDDDG. Sie können Ihre Einwilligung jederzeit über „Cookie-Einstellungen“ widerrufen.</p>\n<p>Auf dem Server werden Aufrufe veröffentlichter Inhalte und API-Aktionen zusammengefasst gezählt, ohne Cookies, IP-Adressen oder andere personenbezogene Daten. Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO; das berechtigte Interesse liegt darin, die Nutzung des Angebots zu verstehen.</p>\n<p>GlitchTip wird in Deutschland selbst gehostet und verarbeitet technische Fehlerberichte aus Browser und Server ohne Cookies oder Browserspeicher. Tokens, E-Mail-Adressen und URL-Parameter werden entfernt. Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO; das berechtigte Interesse liegt in der Betriebssicherheit.</p>\n<p>Umami-Daten werden bis zu 10 Jahre aufbewahrt. Eine automatische Löschung ist nicht eingerichtet. GlitchTip-Fehlerberichte werden nach 90 Tagen gelöscht.</p>",
    },
    en: {
      title: "Analytics and error monitoring",
      body: '<p>Umami is self-hosted by the operator in Germany. Only after you consent in the cookie banner does Umami collect visits, interactions and performance, as well as masked session recordings and heatmaps on Schaffa\'s own pages, not on published content. The legal basis is Art. 6(1)(a) GDPR and Section 25(1) TDDDG. You can withdraw consent at any time through "Cookie settings".</p>\n<p>Views of published content and API actions are counted in aggregate on the server, without cookies, IP addresses or other personal data. The legal basis is Art. 6(1)(f) GDPR; the legitimate interest is understanding how the service is used.</p>\n<p>GlitchTip is self-hosted in Germany and processes technical error reports from the browser and server without cookies or browser storage. Tokens, e-mail addresses and URL parameters are removed. The legal basis is Art. 6(1)(f) GDPR; the legitimate interest is operational security.</p>\n<p>Umami data is retained for up to 10 years. Automatic deletion is not configured. GlitchTip error reports are deleted after 90 days.</p>',
    },
  },
  {
    id: "privacy-11",
    de: {
      title: "Cookies und lokale Speicherung",
      body: "<p>Ohne Anmeldung und ohne Auswahl im Cookie-Banner setzt Schaffa keine Cookies und speichert keine Daten im Browser. Nach Ihrer Auswahl speichert das technisch notwendige Cookie cc_cookie Ihre Banner-Entscheidung für sechs Monate. Umami setzt keine Cookies und liest lediglich eine optionale Opt-out-Einstellung. Bei der Anmeldung werden technisch notwendige Sitzungs-Cookies für das Schaffa-Konto und die Verwaltung sowie Pangolin-Cookies für den Verwaltungszugang verwendet. Hinzu kommen die Shoo-Anmeldeeinträge im Browserspeicher. Diese Speicherung ist für den ausdrücklich gewünschten Zugang und die gewählte Cookie-Einstellung nach § 25 Abs. 2 Nr. 2 TDDDG erforderlich. Rechtsgrundlage für die Verarbeitung zur Zugangssicherung ist Art. 6 Abs. 1 lit. f DSGVO.</p>",
    },
    en: {
      title: "Cookies and local storage",
      body: "<p>Without sign-in and without a choice in the cookie banner, Schaffa does not set cookies or store data in your browser. After your choice, the technically necessary cc_cookie cookie stores your banner decision for six months. Umami sets no cookies and only reads an optional opt-out flag. Signing in uses technically necessary session cookies for the Schaffa account and administration, and Pangolin cookies for administrative access. Shoo sign-in entries are also stored in browser storage. This storage is necessary for the expressly requested access and cookie preference under Section 25(2) no. 2 TDDDG. The legal basis for access security processing is Art. 6(1)(f) GDPR.</p>",
    },
  },
  {
    id: "privacy-12",
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
    id: "privacy-13",
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
    id: "privacy-14",
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
  return `<section id="${section.id}" aria-labelledby="${section.id}-heading"><h2 id="${section.id}-heading">${prefix}${text.title}</h2>${text.body}</section>`;
}

const legalStyles = `:root{font-family:"Avenir Next","Segoe UI",sans-serif;color:#20211e;background:#f3f0e8}*{box-sizing:border-box}body{margin:0;line-height:1.7}header{max-width:980px;margin:auto;padding:24px;display:flex;align-items:center;justify-content:space-between;border-bottom:2px solid #20211e;gap:24px}.wordmark{font:700 28px Georgia,serif;text-decoration:none;color:#20211e}a{color:#8c321c;text-underline-offset:4px;overflow-wrap:anywhere}a:focus-visible{outline:3px solid #a43f24;outline-offset:4px}main{max-width:820px;margin:auto;padding:40px 24px 72px;overflow-wrap:anywhere}h1,h2{font-family:Georgia,"Times New Roman",serif;line-height:1.15;letter-spacing:-.025em}h1{font-size:clamp(34px,6vw,56px);margin:0 0 20px}h2{font-size:26px;margin:0 0 18px}section{padding-top:32px;margin-top:28px;border-top:1px solid #cbc5b8}p{margin:0 0 18px}ul{padding-left:24px}.updated{color:#696961;font-size:14px}@media(max-width:480px){header{padding:20px}main{padding:32px 20px 56px}h2{font-size:23px}}`;
