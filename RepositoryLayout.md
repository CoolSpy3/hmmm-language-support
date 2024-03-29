# Repository Layout
This document highlights the general layout of the repository and the purpose of important files and directories.

```
- ./
  |- .vscode/  # Visual Studio Code configuration files
  |
  |- client/   # VSCode client-side code (Extension initialization and debugger)
  |  \- src/
  |     |- debugadapter.ts  # Implements the Debug Adapter Protocol (DAP) to manage an instance of the HMMM Runtime
  |     |- extension.ts     # Extension entry point (Registers core extension features with VSCode)
  |     |- helperclasses.ts # Helper classes which implement various VSCode interfaces
  |     \- runtime.ts       # Implements the HMMM Runtime
  |
  |- dist/  # Compiled JavaScript files (generated by esbuild)
  |- docs/  # Documentation files
  |
  |- hmmm-spec/  # A TypeScript library which provides helper functions for working with HMMM programs
  |  |             (Shared by both the client and server)
  |  \- src/
  |     \- hmmm.ts  # All the code for the library is located in this file
  |
  |- server/  # VSCode server-side code (Language Servers)
  |  \- src/
  |     |- hbserver.ts         # Implements the Language Server Protocol (LSP) for HMMM Binary files
  |     |- helperfunctions.ts  # Defines helper functions for implementing the LSP and
  |     |                        integrating it with the HMMM language library
  |     |- hmmmserver.ts       # Implements the Language Server Protocol (LSP) for HMMM Assembly files
  |     \- semantictokens.ts   # Defines the semantic tokens available to the HMMM language server and
  |                              provides helper functions for integrating them with the LSP
  |
  |- syntaxes/ # VSCode syntax highlighting files
  |  |- hb-language-configuration.json    # Defines the language configuration for HMMM Binary files
  |  |- hb.tmLanguage.json                # Defines the syntax highlighting for HMMM Binary files
  |  |- hmmm-language-configuration.json  # Defines the language configuration for HMMM Assembly files
  |  \- hmmm.tmLanguage.json              # Defines the syntax highlighting for HMMM Assembly files
  |
  \- package.json  # VSCode extension manifest (defines the extension's name, version, dependencies, etc.)
```

In addition to these files, each of the main subdirectories of this project contain a couple of other files which are not listed above:

```
**/
  |- node_modules/      # Node.js dependencies (installed by npm)
  |- out/               # Compiled JavaScript files (generated by tsc)
  |- package.json       # Various metadata about the code (mostly dependencies)
  |- package-lock.json  # Lock file for npm dependencies
  \- tsconfig.json      # TypeScript configuration file for the code
```
