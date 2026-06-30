# Agentic AI Service Desk 🤖💼

A full-stack, enterprise-ready IT Service Management (ITSM) portal and automated support ticketing platform. It integrates a live **Generative AI Desk Agent** powered by Gemini models, an advanced **RAG (Retrieval-Augmented Generation) Search Engine** referencing a local Knowledge Base, and a persistent **PostgreSQL (SQL DB) Technician Queue** utilizing Drizzle ORM.

---

## 🌟 Key Features

### 1. 🤖 AI Desk Agent (Generative RAG Support)
*   **Step-by-Step Diagnostics**: Resolves complex technical queries (VPN lockouts, Enterprise Wi-Fi settings, PaperCut printer setups, LDAP password expirations, specialized software licenses) through interactive conversational steps.
*   **Contextual Knowledge Injection**: Automatically queries the Knowledge Base using custom keyword scoring heuristics to append semantic references before prompting the LLM.
*   **Autonomous Escalation Hook**: Automatically creates high-fidelity support tickets in the SQL database and assigns them to the appropriate engineering team (e.g. NetOps, SecOps, DevOps, SysAdmin, Facilities) if self-service troubleshooting fails or is impossible (e.g. physical hardware faults, total access lockout).

### 2. ⚡ Autorecovery & Failover Resilience
*   **Transience Handler**: Detects Gemini 503 (Unavailable / High Demand) and 429 (Rate Limit) errors.
*   **Model-Rotation Failover Queue**: Automatically rotates requests through a failover model pipeline (`gemini-3.5-flash` ➡️ `gemini-3.1-flash-lite` ➡️ `gemini-flash-latest`) using exponential backoff to guarantee SLA uptime.
*   **Local Heuristic Bypass**: Seamlessly falls back to local heuristic state routing in the event of total upstream network loss to prevent user-facing downtime.

### 3. 📂 Knowledge Library & Management
*   **Active RAG Search**: Instant keyword-matching, category grouping, and relevance-scored text indexing.
*   **Operator Actions**: Operators can search, upvote helpfulness, and author new articles directly from the web interface.

### 4. 📋 Technician Queue (SQL DB)
*   **Ticket Lifecycle Tracking**: Status updates (`Open` ➡️ `In Progress` ➡️ `Resolved`), priority level adjustment (`Low` to `Critical`), and re-assignment workflows.
*   **Collaborative Work**: Supports engineering audit trails and multi-role comments (User, Agent, Engineer).
*   **Manual Entry Option**: Built-in manual support log bypass.

### 5. 📊 Metrics Dashboard
*   **Real-Time SLA Telemetry**: Interactive metrics on ticket volume, average resolution times, and escalation rates.
*   **Interactive Visualizations**: High-contrast Recharts charts tracking priority distribution, category counts, and daily performance trends.

---

## 🛠️ Tech Stack & Architecture

*   **Frontend**: React (Vite), Tailwind CSS, Lucide Icons, Recharts, Motion (Animate/React).
*   **Backend**: Node.js, Express.js (custom server routing).
*   **Database**: PostgreSQL, Drizzle ORM (type-safe queries, relational schema mapping).
*   **Authentication**: Firebase Authentication (Google Single Sign-In/SAML-compliant JWT Verification).
*   **AI Integration**: Google GenAI SDK (`@google/genai`) with model-rotation failover loops.

---

## 📂 Project Structure

```bash
├── server.ts              # Custom full-stack Express server with RAG routing
├── package.json           # Application dependencies and scripts
├── vite.config.ts         # Vite configuration (Single Port proxy, static assets)
├── README.md              # Documentation of the project
├── src/
│   ├── main.tsx           # Web entry point (wraps App in AuthProvider)
│   ├── App.tsx            # Main application shell and tab-state router
│   ├── types.ts           # Unified TypeScript definitions (Ticket, Comment, etc.)
│   ├── context/
│   │   └── AuthContext.tsx # Firebase Authentication state manager
│   ├── db/
│   │   ├── index.ts       # Database connector
│   │   ├── schema.ts      # Drizzle PostgreSQL schemas
│   │   ├── queries.ts     # Highly optimized PostgreSQL query definitions
│   │   └── seed.ts        # Database seeder (loads initial KB and mock tickets)
│   ├── lib/
│   │   └── firebase.ts    # Firebase client initialization
│   └── components/
│       ├── AgentChat.tsx  # Generative AI Support Interface
│       ├── TicketsList.tsx # SQL Ticket Queue & Management Interface
│       ├── KnowledgeBase.tsx # RAG Knowledge Base Creator and Search
│       └── Dashboard.tsx  # SLA Analytics & Interactive Recharts
```

---

## 🚀 Dev Setup & Installation

### Prerequisites
*   Node.js (v18+)
*   NPM
*   PostgreSQL Database URL
*   Firebase Project Credentials (configured in your environment)
*   Google Gemini API Key

### Installation

1. Clone the repository and install all dependencies:
   ```bash
   npm install
   ```

2. Configure your environment variables in `.env`:
   ```env
   DATABASE_URL=postgresql://user:password@localhost:5432/dbname
   GEMINI_API_KEY=your_gemini_api_key
   # Firebase Web Configuration
   VITE_FIREBASE_API_KEY=your_api_key
   VITE_FIREBASE_AUTH_DOMAIN=your_auth_domain
   VITE_FIREBASE_PROJECT_ID=your_project_id
   ```

3. Launch the development server:
   ```bash
   npm run dev
   ```

4. Build for production:
   ```bash
   npm run build
   ```

5. Start the production server:
   ```bash
   npm run start
   ```

---

## 🔒 Security Compliance
*   **Server-Side Credentials**: All API keys (Gemini, database credentials) are stored securely on the backend server.
*   **JWT Authentication**: API endpoints require standard bearer-token SAML/Google Auth verification, checking user roles before database modifications are committed.
