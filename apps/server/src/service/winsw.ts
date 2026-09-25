import { BRAND } from "@nexus/shared";

export interface ServiceDefinition {
  /** Folder containing node.exe and the server bundle (the install directory). */
  installDir: string;
  nodeExe: string;
  entry: string;
  /** Where Nexus keeps its state (ProgramData\Nexus). */
  home: string;
  logDir: string;
  port: number;
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * WinSW configuration for the Nexus Core Service:
 *  - starts automatically with Windows (delayed, so networking is up),
 *  - restarts on failure with increasing delays (self-healing),
 *  - asks Node to shut down gracefully (Ctrl+C) so apps and PostgreSQL stop cleanly,
 *  - keeps rotated service logs.
 */
export function renderWinswXml(d: ServiceDefinition): string {
  return `<service>
  <id>${xml(BRAND.serviceId)}</id>
  <name>${xml(BRAND.serviceDisplayName)}</name>
  <description>${xml(`${BRAND.productName} — runs your applications, databases, storage, backups and AI in the background.`)}</description>
  <executable>${xml(d.nodeExe)}</executable>
  <arguments>--enable-source-maps --disable-warning=ExperimentalWarning "${xml(d.entry)}"</arguments>
  <workingdirectory>${xml(d.installDir)}</workingdirectory>
  <env name="NODE_ENV" value="production"/>
  <env name="NEXUS_HOME" value="${xml(d.home)}"/>
  <env name="NEXUS_INSTALL_DIR" value="${xml(d.installDir)}"/>
  <env name="NEXUS_PORT" value="${d.port}"/>
  <startmode>Automatic</startmode>
  <delayedAutoStart>true</delayedAutoStart>
  <onfailure action="restart" delay="5 sec"/>
  <onfailure action="restart" delay="30 sec"/>
  <onfailure action="restart" delay="2 min"/>
  <resetfailure>1 hour</resetfailure>
  <stoptimeout>60 sec</stoptimeout>
  <stopparentprocessfirst>true</stopparentprocessfirst>
  <logpath>${xml(d.logDir)}</logpath>
  <log mode="roll-by-size">
    <sizeThreshold>10240</sizeThreshold>
    <keepFiles>8</keepFiles>
  </log>
</service>
`;
}
