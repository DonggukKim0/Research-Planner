# Tauri + React + Typescript

This template should help get you started developing with Tauri, React and Typescript in Vite.

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)

## 💬 Feedback & Ideas

Found a bug, have a suggestion, or want a new feature?

Open a GitHub Issue — feedback from fellow researchers is highly appreciated and helps improve Research Planner for everyone.

---

## macOS Security Notice

This app is currently **not notarized by Apple**, so macOS Gatekeeper may block it on first launch.  
This is a normal macOS security behavior for unsigned apps.

### If you see:
“Research Planner is damaged and can’t be opened”  
or macOS refuses to launch the app:

---

### Step 1 — Try opening once

1. Move **Research Planner.app** to Applications  
2. Double-click to open  
3. macOS may show a warning and block it  
4. Click **Cancel**

This is expected.

---

### Step 2 — Remove quarantine flag

Open Terminal and run:

```bash
cd /Applications
xattr -dr com.apple.quarantine "Research Planner.app"
```

---

### If you get a permission error

macOS may block Terminal or Visual Studio Code from modifying app attributes.

In that case:

1. Open **System Settings → Privacy & Security**
2. Go to **App Management**
3. Enable permission for **Terminal** or **Visual Studio Code**
4. Run the command again:

```bash
xattr -dr com.apple.quarantine "Research Planner.app"
```

---

### Step 3 — Launch again

Now open the app normally.  
It should run without issues.

---

### What this command does

This does **not modify the app itself**.  
It only removes the quarantine flag that macOS adds to downloaded apps.

Future releases may include Apple notarization for smoother installation.