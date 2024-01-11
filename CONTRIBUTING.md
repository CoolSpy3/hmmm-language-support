# Contributing
## How to contribute
I've spent a good chunk of time making sure that this project is feature-rich, reliable, and easy to use, but I'm sure there's still room for improvement. If you have any suggestions, bug reports, or feature requests, please open an issue on this repository (the more detail you can provide, the better). Alternatively, if you'd like to contribute to the project yourself, feel free to open a pull request, and I'll review it as soon as I can.

## Testing the Extension from Source
Before you can test the extension, you must download all the necessary dependencies. This can be done as follows:
1. Make sure you have [Node.js and NPM](https://nodejs.org/en/) installed
2. Install TypeScript by using the command `npm install -g typescript` (I think this is only necessary if you want to run `tsc` by hand) (Still recommended tho)
3. Clone this repository and navigate to the root directory
4. Run `npm install` to install all the necessary dependencies
5. Install the [TypeScript esbuild problem matchers](https://marketplace.visualstudio.com/items?itemName=nhedger.ts-esbuild-problem-matchers) extension (This is necessary for the extension debugger to work properly) (It should be in workspace recommendations).

After you've installed all the dependencies, you can test the extension by starting a debug session in VSCode. This can be done by pressing `F5` or by clicking the "Run and Debug" button in the sidebar and selecting "Launch Extension". This will open a new VSCode window with the extension installed. You can then open a new file and start using the extension. Additionally, you can set breakpoints in the source code and make use of TypeScript's debugging tools.
