from pathlib import Path
from xml.sax.saxutils import escape
from reportlab.pdfgen import canvas
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak, Preformatted
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import letter

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'output/pdf/Nexus Deployment Requirements Guide.pdf'
OUT.parent.mkdir(parents=True, exist_ok=True)
styles = getSampleStyleSheet()
styles.add(ParagraphStyle(name='BodyGuide', fontName='Helvetica', fontSize=10, leading=14, spaceAfter=8))
styles.add(ParagraphStyle(name='SmallGuide', fontName='Helvetica', fontSize=8, leading=11, spaceAfter=5))
styles.add(ParagraphStyle(name='CodeGuide', fontName='Courier', fontSize=8.5, leading=12, spaceAfter=10))
styles['Title'].fontName='Helvetica-Bold'; styles['Title'].fontSize=26; styles['Title'].leading=30; styles['Title'].alignment=TA_LEFT; styles['Title'].textColor=colors.black
for name in ['Heading1','Heading2']:
    styles[name].textColor=colors.black; styles[name].fontName='Helvetica-Bold'
styles['Heading1'].fontSize=20; styles['Heading1'].leading=24; styles['Heading1'].spaceAfter=12
styles['Heading2'].fontSize=12; styles['Heading2'].leading=16; styles['Heading2'].spaceBefore=10; styles['Heading2'].spaceAfter=6
story=[]
def p(t, style='BodyGuide'): story.append(Paragraph(t,styles[style]))
def h(t): p(t,'Heading2')
def lead(t): p(t,'Heading1')
def code(t): story.append(Preformatted(t,styles['CodeGuide']))
def page(t): story.append(PageBreak()); lead(t)
def table(headers, rows, widths):
    data=[[Paragraph(escape(str(x)),styles['SmallGuide']) for x in row] for row in [headers]+rows]
    tbl=Table(data,colWidths=widths,repeatRows=1,hAlign='LEFT')
    tbl.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,0),colors.HexColor('#E5EDF5')),('GRID',(0,0),(-1,-1),.5,colors.HexColor('#D9D9D9')),('VALIGN',(0,0),(-1,-1),'MIDDLE'),('LEFTPADDING',(0,0),(-1,-1),8),('RIGHTPADDING',(0,0),(-1,-1),8),('TOPPADDING',(0,0),(-1,-1),7),('BOTTOMPADDING',(0,0),(-1,-1),5)]))
    story.append(tbl); story.append(Spacer(1,10))

p('Nexus Deployment<br/>Requirements Guide','Title')
p('What to prepare for each application and service','Heading2')
p('Draft for application owners and developers | 8 November 2026','SmallGuide')
p('Nexus can host supported web applications and static websites on your Windows computer, manage PostgreSQL and MongoDB databases, store application files, run data pipelines, and connect to local AI. A successful deployment starts with a complete project, declared dependencies, usable configuration, and a clear way to build or start it.')
p('This guide explains what you must supply, what Nexus prepares automatically, and the limits to check before deployment. Framework recognition is a starting point; the application still has to install, start, and pass its checks. [1-5]')
h('Choose the right deployment path')
table(['What you want to run','Where it belongs','Details'],[
('HTML websites and frontend builds','Applications','Page 2'),
('Node.js APIs and full stack JavaScript apps','Applications','Page 3'),
('Python APIs and Streamlit dashboards','Applications','Page 4'),
('R Shiny and combined frontend and backend apps','Applications','Page 5'),
('Databases and persistent application files','Data and app configuration','Page 6'),
('SQL, Python and R data jobs','Pipelines','Page 7'),
('Local AI and Nexus extensions','AI and Settings > Plugins','Page 8'),
('Final checks and implementation references','Before going live','Page 9')],[245,173,86])
h('Prepare these items for every web application')
p('<b>Source:</b> a local folder on the Nexus computer containing the actual application, dependency files, source code, assets, and any migration files. Clone or extract the project first; the current wizard selects a folder.')
p('<b>Configuration:</b> the required settings, API keys, database choice, and access mode. Include an <font face="Courier">.env.example</font> to describe settings. Review the offered import of real environment files; Nexus excludes those files from release copies.')
p('<b>Runtime behavior:</b> a production build or start command, compatibility with the available Windows runtime, and enough disk, memory, and network access for installation and operation. Long running web apps must listen on the port Nexus assigns.')

page('Static websites and frontend apps')
h('Plain HTML CSS and JavaScript')
p('<b>You provide:</b> an <font face="Courier">index.html</font> and every CSS, JavaScript, image, font, and other asset it uses. Nexus recognizes the index at the selected root or in <font face="Courier">public</font>, <font face="Courier">www</font>, or <font face="Courier">site</font>. [2]')
code('my-site/\n  index.html\n  styles.css\n  app.js\n  assets/')
p('<b>Nexus handles:</b> copying a release and serving the files through its gateway. A plain static website needs neither an application server process nor a database.')
p('<b>Check before deploying:</b> all referenced files exist and URLs work from the deployed address. A database or secret API call requires a backend; browser files must not contain private credentials. If using another static site generator, build it first and select the generated output folder containing index.html.')
h('React Vue Angular Svelte Solid and Preact')
p('<b>You provide:</b> a valid <font face="Courier">package.json</font>, source files, the matching package lockfile, and a production <font face="Courier">build</font> script. Nexus recognizes these frontend frameworks from dependencies. Vite is handled through the recognized framework. [2]')
code('my-frontend/\n  package.json       # includes scripts.build\n  package-lock.json  # or pnpm-lock.yaml / yarn.lock\n  index.html\n  src/\n  public/')
p('<b>Nexus handles:</b> dependency installation, the declared build, and serving the generated files. Most frontends are expected in <font face="Courier">dist</font>; Create React App uses <font face="Courier">build</font>. Angular output is inferred from angular.json or dist/&lt;package-name&gt;. Frontend routes receive single page application fallback behavior. [2, 5]')
p('<b>Check before deploying:</b> the build output matches the detected directory. In particular, confirm Angular configurations with nested browser output or newer outputPath formats. Development servers such as vite or ng serve are not the production deployment.')
h('Settings embedded in the browser build')
p('Enter public build settings before deploying. Nexus passes names beginning with <font face="Courier">VITE_</font>, <font face="Courier">REACT_APP_</font>, <font face="Courier">NEXT_PUBLIC_</font>, <font face="Courier">NUXT_PUBLIC_</font>, <font face="Courier">GATSBY_</font>, or <font face="Courier">PUBLIC_</font> to the build. These values can become visible in browser assets. A recognized prefix does not itself mean the associated framework has a deployment adapter. [5]')
p('Use a relative API address such as <font face="Courier">/api</font> for a combined app where possible. Changing a value compiled into frontend files requires a new build and deployment.')

page('Node.js and full stack JavaScript')
h('Node.js APIs and server applications')
p('<b>Recognized:</b> Express, Fastify, NestJS, Koa, hapi, Hono, and generic Node projects with a usable start entry. JavaScript and TypeScript are detected. [2]')
p('<b>You provide:</b> package.json, dependencies, a matching lockfile, and a production start script. For TypeScript, provide a build script that generates the JavaScript your start script runs. Nexus can also infer selected common entry files, but an explicit start script is clearer.')
code('"scripts": {\n  "build": "tsc",\n  "start": "node dist/server.js"\n}\n\n// In your server code:\nconst port = Number(process.env.PORT || 3000);\nconst host = process.env.HOST || "127.0.0.1";\napp.listen(port, host);')
p('<b>Nexus handles:</b> npm ci when package-lock.json exists, otherwise npm install. A pnpm or Yarn lockfile selects that manager with a frozen lockfile; its runtime support must be available. Nexus builds detected TypeScript backends with a build script, starts the primary server, and supervises it. [2-4]')
p('<b>Check before deploying:</b> the process stays running, obeys PORT and HOST, and starts without interactive prompts or tools found only in your personal PATH. Native dependencies must install on Windows. An engines.node value is detected, but the process deployment uses the configured Node executable; it does not automatically install every requested Node version.')
h('Next.js Nuxt Remix and SvelteKit')
p('<b>You provide:</b> framework dependencies, its production build script, and an explicit production start script appropriate to the chosen adapter and output. A successful local development session is not enough.')
p('<b>Nexus handles:</b> framework detection, dependency installation, the declared build, and a supervised server. Next.js and Nuxt have inferred start fallbacks. <b>Remix and SvelteKit should always supply their own production start script:</b> the current shared fallback is not specific to those frameworks. [2]')
p('<b>Check before deploying:</b> the server binds to the assigned address and port, the selected adapter produces a runnable server, and any database initialization or build time requirements are satisfied. Private runtime settings are not automatically made available to frontend compilation.')
h('What the application must expose')
p('Use an HTTP server for the Applications workflow. A health endpoint such as /health is helpful; automatic monitoring can fall back to a general HTTP response when an inferred endpoint is invalid. A one shot script or a queue worker without HTTP is not a normal web deployment. Use Pipelines for supported finite jobs. [5]')

page('Python web apps and dashboards')
h('Requirements shared by Python apps')
p('<b>You provide:</b> source files, a clear entry point, and <font face="Courier">requirements.txt</font>, an installable <font face="Courier">pyproject.toml</font>, or a Pipfile. Nexus reads Python version hints from pyproject.toml, .python-version, or runtime.txt. Its bundled Python is 3.12; another requirement needs a compatible runtime available to the service. [1-3]')
p('<b>Nexus handles:</b> a private virtual environment per release and pip installation. Requirements files take precedence; an installable pyproject uses pip install .; Pipfile dependencies can become direct pip installs. Detecting poetry.lock, uv.lock, or Pipfile does <b>not</b> mean Nexus runs that tool to reproduce its complete lockfile.')
h('Flask')
p('Declare Flask and all other dependencies. Provide an app object such as <font face="Courier">app = Flask(__name__)</font>, or a discoverable create_app or make_app factory. Nexus starts the detected target with Waitress and adds Waitress when needed. Its generated command binds to loopback and the assigned port. Complex dynamic factories may require changing the project layout or entry point. [2]')
h('FastAPI Starlette and Quart')
p('Declare the framework and provide a discoverable app object or factory. Nexus runs it through Uvicorn and adds Uvicorn when needed. Standard src layouts can receive a PYTHONPATH adjustment. [2]')
code('# requirements.txt\nfastapi\nuvicorn\n\n# main.py\nfrom fastapi import FastAPI\napp = FastAPI()\n\n@app.get("/health")\ndef health():\n    return {"ok": True}')
h('Django')
p('Provide manage.py, the Django project package, settings, migration files, and the dependencies. The detector derives the project from DJANGO_SETTINGS_MODULE in manage.py. It normally uses Waitress with the WSGI application; detecting Channels or Daphne selects Uvicorn with ASGI. [2]')
p('Configure your deployed hostnames, secret key, database, and production static and media handling. Do not assume that deploying performs collectstatic or configures Django static file serving. Recognized migrations may run during deployment when a managed PostgreSQL connection is present. [5]')
h('Streamlit and plain Python')
p('For Streamlit, list streamlit as a dependency and include an entry such as streamlit_app.py. Nexus starts its headless server and assigns the bind address and port; multipage files remain under pages/. A plain Python app can be detected from main.py, app.py, server.py, or run.py, but it must remain running and serve HTTP for the normal Applications workflow. Finite scripts belong in Pipelines. [2, 5]')

page('R Shiny and combined applications')
h('R Shiny dashboards')
p('<b>You provide:</b> <font face="Courier">app.R</font>, or both <font face="Courier">ui.R</font> and <font face="Courier">server.R</font>, plus the files the app reads. Include renv.lock when exact package versions matter. Install R so the Nexus service can use it; an all users installation under Program Files is the expected service setup. [2, 3]')
code('my-shiny-app/\n  app.R\n  renv.lock     # recommended for reproducibility\n  R/\n  www/\n  data/')
p('<b>Nexus handles:</b> detecting packages used by common library, require, namespace, and pacman patterns; creating a private package library; installing packages or restoring renv.lock; and launching shiny::runApp on loopback and the assigned port.')
p('<b>Check before deploying:</b> all dynamically loaded packages are declared, file paths work outside your RStudio session, and packages can install on Windows. Source packages may need Rtools. Nexus prefers the requested R version, then a matching major and minor version, then another installed version; review compatibility if it falls back. A generic R script or R Markdown file is not automatically a Shiny application.')
h('One frontend with one backend')
p('<b>You provide:</b> a project with recognizable component folders. Nexus checks server, backend, api, client, frontend, web, ui, app, and site directly below the selected root. It can combine complementary frontend and backend roles, for example React with Express or React with FastAPI. [2]')
code('my-app/\n  backend/\n    package.json\n    server.js\n  frontend/\n    package.json\n    src/')
p('<b>Nexus handles:</b> component installation and builds, one primary application server, and gateway serving of the frontend. When both static frontend output and a backend exist, the current gateway routes <font face="Courier">/api</font> requests to the backend. Make the backend routes and frontend URLs agree with that prefix. [5]')
p('<b>Check before deploying:</b> arbitrary workspace trees such as packages/service-a and apps/service-b are not exhaustively orchestrated. Multiple APIs, queue workers, or several components of the same role are not all launched automatically. Package each independent web service separately or adapt the layout to the detected deployment model.')
h('Node.js apps that call Python helpers')
p('Include the Python helper source and its dependency manifest. Nexus can prepare an auxiliary Python environment without starting a second web server. It exposes PYTHON, PYTHON_EXECUTABLE, and NEXUS_PYTHON to identify that interpreter. Have the Node application use the supplied interpreter rather than a hard coded path to your personal Python installation. [2-4]')

page('Databases and persistent files')
h('Choose the engine your application actually uses')
table(['Data type','What you supply','What Nexus provides'],[
('PostgreSQL','PostgreSQL compatible code, schema or migrations, and connection variable names.','A new database and app login, or access to an existing managed database; detected settings are wired.'),
('MongoDB','MongoDB compatible code and connection settings; disclose transaction needs.','Managed document databases using replica sets. Legacy FerretDB databases remain a separate compatibility option.'),
('External database','A reachable server, valid credentials, compatible driver, and any required TLS settings.','Stores the configured connection URL in detected URL variables; it does not operate the external server.'),
('SQLite','A database file or initialization logic and a persistent file location.','The application uses SQLite itself; detection does not convert it to PostgreSQL.'),
('MySQL or SQL Server','Your own matching server and driver, or a deliberate application migration.','Recognition of the requirement; no built in provisioning of these engines is established by the current app flow.')],[92,209,203])
p('The Data step offers a new database, an existing database, an external connection, or no database. A new managed SQL database is PostgreSQL. Selecting it for a MySQL, SQL Server, or SQLite project does not translate SQL, change the driver, or migrate existing data. [2, 5, 6]')
h('Schema and migrations')
p('Supply migration files and ensure the command can run without prompts. Nexus recognizes several migration systems, including Prisma, Knex, Sequelize, Drizzle, Django, Alembic, and node-pg-migrate. Detection alone does not guarantee automatic execution: the deployment needs an executable migration marked autoRunnable and a managed PostgreSQL connection. Raw SQL files and unresolved commands need explicit handling. [2, 5]')
p('Treat migrations as real database changes. Rolling application code back does not automatically reverse schema changes or restore data. Keep a backup and use schema changes compatible with the previous release where continuity matters.')
h('Uploads documents and other durable files')
p('Write durable files to the app storage directory, available as <font face="Courier">NEXUS_STORAGE_DIR</font>, or use the scoped storage API. Nexus also maps detected storage environment settings to an app persistent directory. Make sure your code reads that setting; a hard coded ./uploads path is not automatically rewritten. [5, 6]')
p('Release folders are replaced as versions change. Do not keep the only copy of uploads, a SQLite database, generated reports, or other business data inside a release. Confirm the backup includes the chosen persistent location and that a restore recovers the files you need.')

page('Data pipelines and scheduled scripts')
h('SQL and connector workflows')
p('<b>You provide:</b> a pipeline built in the designer or a valid YAML definition, readable inputs, connection details, transformations, and an output destination. SQL transformations use DuckDB; database ELT blocks run their SQL in the selected Warehouse or PostgreSQL database. Use the SQL dialect for the chosen block. [7]')
p('<b>Available building blocks include:</b> PostgreSQL, MongoDB and SQLite reads; CSV, Excel, JSON and Parquet files; HTTP APIs; Nexus Storage; Warehouse reads and writes; SQL transformations; Python and R scripts; and file or HTTP output. Each block has its own required fields.')
code('nexus: pipeline/v1\nname: Daily sales copy\nschedule:\n  type: manual\nsteps:\n  - id: sales\n    uses: csv.read\n    with:\n      path: C:/Data/sales.csv\n  - id: save\n    uses: warehouse.write\n    with:\n      table: sales_copy\n      mode: replace')
p('This example needs the input file and Warehouse to be available. The replace mode replaces the destination data; choose append or upsert when that matches the intended behavior.')
h('Python pipeline steps')
p('Provide an absolute script path, a compatible Python version where needed, and the required packages. Use <font face="Courier">from nexus import input_data, output_data</font> to receive and return tabular data. Declare secrets through the pipeline facilities rather than embedding values in the script. [7]')
code('from nexus import input_data, output_data\nrows = input_data()\nclean = rows.drop_duplicates()\noutput_data(clean)')
h('R pipeline steps')
p('Provide an absolute R script path, an available R runtime, and package requirements. Nexus runs Rscript with an isolated library and its nexusR helpers attached. Use nexus_input() and nexus_output() for the handoff. Shiny UI files are not required for an R pipeline. [7]')
h('Scheduling and readiness')
p('Nexus supports manual runs, intervals, daily, weekly, monthly and cron schedules, file triggers, and runs after other pipelines. It manages dependencies between steps, retries, checkpoints, and run history. Test with representative data before enabling a schedule; check path permissions, column names and types, output mode, secrets, and resource limits. A script that never returns is not a suitable finite pipeline step.')

page('Local AI plugins and support limits')
h('Local AI')
p('<b>You provide:</b> an installed and running Ollama engine, enough RAM or GPU memory for the chosen model, disk space for model files, and connectivity for initial downloads. Model choice should follow the Nexus hardware recommendation. [1]')
p('<b>Nexus handles:</b> connecting to the local engine and providing its AI features, including help with errors, server questions, and pipeline drafts. The current product describes the assistant as recommendation only. Installing a model in the AI engine is a separate workflow from deploying an app folder.')
p('<b>Check before deploying an AI powered app:</b> include the app itself under its supported runtime, configure its model endpoint, and verify its memory and concurrency needs. The AI integration is not a general automatic deployment path for arbitrary model weights, training systems, or inference servers.')
h('Nexus plugins')
p('<b>You provide:</b> a self contained plugin folder with <font face="Courier">nexus-plugin.json</font>, a JavaScript or MJS entry file inside the folder, and all runtime dependencies already packaged. The manifest declares nexus: plugin/v1, its identity, version, API version, entry, and capabilities. [8]')
code('my-plugin/\n  nexus-plugin.json\n  dist/\n    main.mjs')
p('<b>Nexus handles:</b> package validation, capability review, copying the plugin into managed storage, and lifecycle management. Install leaves the plugin off. Enabling it starts the process and requires the ready handshake for protocol 1 with the exact declared capabilities.')
p('<b>Check before installing:</b> the plugin must not rely on Nexus running npm install, setup scripts, or downloads. An administrator approves capabilities. Plugins execute as local processes under the service identity; capability approvals are not an operating system sandbox. Use the documented JSON lines protocol.')
h('What the standard deployment path does not promise')
p('<b>Docker and Compose:</b> the detector records Dockerfile presence and the runtime package includes a Podman provider. The inspected application launch flow chooses its default isolation provider and does not implement a general Dockerfile or Compose build and deployment workflow. A Dockerfile alone does not make a project deployable. [2, 4, 5]')
p('<b>Other application stacks:</b> PHP and WordPress, Java and .NET servers, Ruby applications, arbitrary Windows executables, desktop GUI programs, and mobile binaries have no built in detector and installer in the reviewed app flow. They need additional supported integration or separate hosting. A mobile app backend can still use a supported web runtime.')
p('<b>Workers and multi service systems:</b> framework recognition does not provision Redis, message brokers, search engines, or every child service. Supply and configure those dependencies separately. Use independent app deployments for independent HTTP services; use Pipelines for supported scheduled or finite data work.')

page('Deployment checklist and references')
h('Run through the deployment wizard')
p('<b>1. Folder:</b> choose the actual project folder on the server. <b>2. Analysis:</b> verify every detected component, review warnings, and supply or import required settings. <b>3. Data:</b> choose the correct database engine and whether to create, reuse, connect externally, or use none. <b>4. Access:</b> choose the intended audience. <b>5. Deploy:</b> watch installation, build, database setup, startup, and verification. <b>6. Ready:</b> open the displayed address and test a real user action. [5]')
h('Before sharing the application')
p('Confirm that the expected page or API responds; login and authorization work; the app can read and write its database; uploads survive a restart and redeployment; and the logs show no startup errors. Check the configured backup and perform a suitable restore test before depending on the application.')
p('For direct public hosting, configure a domain and DNS plus the required router and firewall access to the gateway. Public HTTPS also needs certificate issuance to succeed. A private app or private network has a different reachability setup. Optional WireGuard private access requires WireGuard installation. Remote administration is a separate setting and requires password and two step verification. [1, 5]')
h('Common blockers and the next check')
p('<b>Not recognized:</b> select the folder with the manifest or index and confirm the layout. <b>Install fails:</b> check lockfiles, downloads, runtime versions, and native build tools. <b>Startup fails:</b> check the production entry, required settings, assigned port, and database.')
p('<b>API fails:</b> check /api routing and remove development URLs. <b>Files disappear:</b> use persistent storage. <b>Public URL fails:</b> check DNS, domain settings, gateway reachability, TLS, and access mode.')
h('Implementation references')
p('Scope: Nexus source checkout reviewed on 8 November 2026; repository HEAD 63c7748. Paths below are relative to the project root. These references describe implementation behavior, not a certification that every possible application has been tested.','SmallGuide')
refs=[
'[1] README.md and HOW-TO-USE-NEXUS.md - product scope, installation, runtime and access requirements.',
'[2] packages/detection/src/analyze.ts, node.ts, python.ts, r.ts and signals.ts - recognized layouts, frameworks, commands, databases and migrations.',
'[3] packages/deployment/src/deployments.ts, python-runtime.ts and r-runtime.ts - release preparation, dependency installation and runtime selection.',
'[4] packages/runtime/src/resolve.ts, env.ts, registry.ts and podman-provider.ts - command resolution, process environment and isolation adapters.',
'[5] apps/ui/src/pages/AddApplication.tsx; apps/server/src/services/apps.ts; packages/network/src/gateway.ts - wizard, deployment sequence, settings, monitoring and routing.',
'[6] packages/storage/src and packages/database/src - persistent storage and managed database services.',
'[7] packages/pipelines/src/definition.ts, blocks.ts, python/step.ts and r/step.ts; packages/pipelines/helpers - pipeline contracts and script handoff.',
'[8] docs/plugins.md - local plugin packaging, protocol and lifecycle.'
]
for r in refs:p(r,'SmallGuide')

def footer(c,doc):
    c.setFont('Helvetica',8); c.setFillColor(colors.HexColor('#555555'))
    c.drawString(54,30,'Nexus Deployment Requirements Guide')
    c.drawRightString(558,30,str(doc.page))

doc=SimpleDocTemplate(str(OUT),pagesize=letter,rightMargin=54,leftMargin=54,topMargin=45,bottomMargin=48,title='Nexus Deployment Requirements Guide',author='Nexus',pageCompression=1)
doc.build(story,onFirstPage=footer,onLaterPages=footer)
print(OUT)
