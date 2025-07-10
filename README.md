# PDF Filler - Session-Based Document Approval System

A PDF signing and approval system that integrates with Microsoft Power Automate for document workflows. This application enables secure document signing with a complete session lifecycle for document revision workflows.

## 🌟 Features

- **Session-Based Document Management**: All documents are tracked within sessions
- **Dual Document Support**: Process original documents alongside Document Amendment Records (DAR)
- **Power Automate Integration**: Seamlessly works with multi-flow Power Automate systems (supports 4-flow architecture)
- **Comprehensive Error Handling**: Clear error messages and status codes
- **Modal-Based User Interface**: Provides clear feedback to users
- **Database-Driven**: Fully database-driven with no filesystem state tracking
- **Automatic Cleanup**: Expired sessions and documents are automatically removed

## 🔧 System Requirements

- Node.js (v14+)
- SQLite3
- Modern web browser

## 📋 Setup Instructions

1. **Clone the repository**

```bash
git clone https://github.com/iamhx/pdf-filler.git
cd pdf-filler
```

2. **Install dependencies**

```bash
npm install
```

3. **Configure environment variables**

```bash
cp .env.example .env
```

Edit the `.env` file to set your Power Automate webhook endpoints and other configuration options.

4. **Initialize the application**

```bash
npm start
```

## 💻 API Endpoints

### PDF Upload Session
- **POST** `/api/pdf/upload-session`
- Creates a new approval session with two documents (original and DAR)
- Requires: callbackUrl and two documents with base64-encoded content

### PDF View/Access
- **GET/HEAD** `/api/pdf/:fileId?sessionId=xxx`
- Retrieves or checks a PDF document
- Requires: Valid file ID and session ID

## 🔄 Session Workflow

1. Power Automate uploads two documents (Original document and Document Amendment Record) to create a session
2. User views and signs/declines documents through email links
3. System notifies Power Automate of completion/decline via webhooks
4. Session is marked as completed and files are cleaned up

### Document Terminology

- **Original Document**: The final document with all changes accepted
- **Document Amendment Record (DAR)**: Document showing tracked changes/revisions

## 🛠️ Administration

The system includes an admin CLI for managing sessions and files:

```bash
node scripts/admin-cli.js stats     # View system statistics
node scripts/admin-cli.js sessions  # List all sessions
node scripts/admin-cli.js cleanup   # Clean up expired items
```

## 📄 Documentation

- For complete Power Automate integration details, see [Power Automate Integration Guide](docs/power-automate-integration.md)
- For end-user instructions, see [User Guide](docs/user-guide.md)

## 🔌 Integration with Power Automate

This application is designed to work with Microsoft Power Automate using a 4-flow architecture:

1. **Document Update Flow**: Main flow that handles the document update process
2. **Approval Webhook**: Handles document upload and email notifications
3. **Success Webhook**: Processes successfully signed documents
4. **Declined Webhook**: Manages declined document scenarios

For testing webhook integrations, you can use [httpbin.org](https://httpbin.org/post) as a callback URL endpoint.

## 📝 License

[ISC License](LICENSE)

---

Created for secure document signing and approval workflows. Designed to integrate seamlessly with Microsoft Power Automate.
