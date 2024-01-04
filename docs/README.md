# HMMM Language Support Documentation
This is the documentation for the HMMM Language Support extension for Visual Studio Code. This extension provides syntax highlighting and debugging support for HMMM assembly and HMMM binary files. What follows is a detailed description of the features of this extension.

## Editor Features
### HMMM Assembly

#### Syntax Highlighting
The HMMM Language Support extension provides syntax highlighting for HMMM assembly files. This includes highlighting for instructions, registers, numbers, comments, line numbers, and pushr/popr instructions. Additionally, the registers `r0`, `r13`, `r14`, and `r15` are highlighted differently to indicate that they have special uses in HMMM conventions (or in the case of `r0`, the HMMM language itself).

#### Code Validation
The extension will attempt to validate code in HMMM assembly files. This includes checking for missing or incorrect line numbers, invalid instructions, and invalid operands for each instruction. Additionally, the extension will attempt to suggest fixes for errors that it finds.

A full list of errors and fixes that the extension can provide is listed below:

##### Errors
* Invalid Line - The extension cannot interpret the line as HMMM code. The extension is designed to be able to handle most common errors, so it is unlikely that you will encounter this error.
	* *No quick fixes provided*
* Missing Line Number - The line is missing a line number. All lines in HMMM assembly must have a line number.
	* *Quick Fix*: Add a line number to the line. (The extension will suggest the line number which corresponds to the number of code lines above the line in the file.)
* Incorrect Line Number - The line number does not match the expected number of the line.
	* *Quick Fix*: Change the line number to the expected number.
* Missing Instruction - The line is missing an instruction.
	* *No quick fixes provided*
* Unknown Instruction - The instruction is not a valid HMMM instruction.
	* *No quick fixes provided*
* Invalid Operand - An operand to an instruction is invalid. This error is emitted when the extension cannot interpret an operand as either a register or a number.
	* *No quick fixes provided*
* Invalid Register - An operand to an instruction is a register that is above r15 (r16+) rather than a valid HMMM register (r0-r15).
	* *No quick fixes provided*
* Invalid Number - An operand to an instruction is a number that is outside the range of numbers which can be represented in HMMM binary (-128-255)
	* *No quick fixes provided*
* Invalid Operand Type - One of the operands to an instruction is of the wrong type. Either a register was provided instead of a number or vice versa. Alternatively, the instruction requires a number, but the provided number is not in the range of numbers which the instruction accepts (-128-127 for signed numbers and 0-255 for unsigned numbers).
	* *No quick fixes provided*
* Missing Operand - An instruction is missing an operand.
	* *No quick fixes provided*
* Extra Operand - An instruction has more operands than it should.
	* *Quick Fix*: Remove the extra operand(s) from the instruction.
* Unexpected Token - The extension encountered more tokens than should be on a line (more than 3 instruction arguments).
	* *Quick Fix*: Remove the extra token(s) from the line.
* Jump destination is outside of code segment (*warning*) - The extension encountered a jump or call instruction which jumps to a line outside of the code segment. For most HMMM code, this is an error, but there are some cases (in self-modifying code) where this is intentional.
	* *No quick fixes provided*

#### Code Completion
The extension provides code completion for HMMM assembly files. This includes code completion for line numbers, instructions, and registers. Additionally, the extension will provide information about each instruction when it is selected in the code completion list.

When providing code completions, the extension will only provide completions that are valid for the current context. For example, if the user is typing an instruction, the extension will only provide instructions as code completions. Similarly, if the user is typing a register, the extension will only provide registers as code completions. Which code completions are provided are determined by the current position of the cursor in the line.

When instruction completions are provided, the extension will provide information about the instruction such as its description, operands, and its binary representation.

#### Goto Definition
The extension provides the ability to jump to the line referenced by a jump or call instruction. This can be accessed by right clicking on the jump-to address and selecting "Go to Definition" from the context menu. Alternatively, the user can press `F12` while the cursor is on the jump-to address.

#### Find All References
Along with finding the line a particular instruction jumps to, the extension also provides the ability to find all instructions that jump to a particular line. This can be accessed by right clicking on the line number and selecting "Find All References" from the context menu. Alternatively, the user can press `Shift+F12` while the cursor is on the line number.

#### Code Hovers
When hovering over an instruction or register, the extension will provide the description of the instruction or register.

#### Formatting
The extension provides formatting for HMMM assembly files. This will normalize the length of all line numbers and align all operands and comments to the same column. Ex. the code:
``` hmmm
0 setn r1 1 # Reset r1
1 addn r1 r1 r2 # r1 += r2
```

will be formatted to:
``` hmmm
0 setn r1 1     # Reset r1
1 addn r1 r1 r2 # r1 += r2
```
A file can be formatted by right clicking in the file and selecting "Format Document" from the context menu. Alternatively, the user can press `Shift+Alt+F` while the cursor is in the file or enable VSCode's "Format on Save" setting.

### HMMM Binary

The [HMMM Specification](https://www.cs.hmc.edu/~cs5grad/cs5/hmmm/documentation/documentation.html) does not go into detail about the format of HMMM binary files. A such, I've assumed that the format of HMMM binary files is as follows:
* HMMM Binary files contain lines which each contain a single 16-bit binary number
* Numbers may have leading/trailing whitespace and spaces between their digits
* The only characters allowed in a HMMM Binary file are `0`, `1`, and whitespace
* Comments are not supported
* Blank lines are allowed

This conforms to the format of code outputted by the CS5 HMMM assembler.

At some point, I would like to discuss with the CS5 professors to verify these assumptions.

#### Code Validation
The extension will attempt to validate code in HMMM binary files and will highlight any invalid lines. Because the HMMM Binary format represents compiled code, it is more difficult to determine the user's intent when invalid code is found. As a result, this extension does not provided detailed error information or quick fixes for HMMM Binary files.

#### Semantic Highlighting
When a HMMM Binary file is opened, the extension will attempt to parse each line and provide semantic highlighting. This includes highlighting any bits which represent instructions, registers, or numbers with the same highlighting colors as HMMM assembly files.

The semantic highlighting feature is provided by the HMMM Binary language server. Before the server has loaded, VSCode will fallback on a default language definition which will highlight all bits in the file as binary numbers.

#### Disassembly Hints
When a HMMM Binary file is opened, the extension will attempt to parse each line and provide inlay hints which show the disassembly of each line.

#### Formatter
The extension provides formatting for HMMM Binary files. This will place spaces between every nibble (4 bits) and align all lines to the same column. Ex. the code:
``` hb
0000000000000000
```

will be formatted to:
``` hb
0000 0000 0000 0000
```

A file can be formatted by right clicking in the file and selecting "Format Document" from the context menu. Alternatively, the user can press `Shift+Alt+F` while the cursor is in the file or enable VSCode's "Format on Save" setting.
