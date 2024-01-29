# HMMM Language Support

Provides language support for the [Harvey Mudd Miniature Machine (HMMM) Language](https://www.cs.hmc.edu/~cs5grad/cs5/hmmm/documentation/documentation.html).

## Features

This is a quick bullet list of the features provided by this extension. For a detailed explanation of all features, check out the [documentation page](https://github.com/CoolSpy3/hmmm-language-support/blob/main/docs/README.md).

### Editor Features

#### HMMM Binary Files
* File (Instruction) Validation
* Disassembly Hints
* Semantic Tokens
* Formatter

#### HMMM Assembly Files
* Syntax Highlighting
	* Instructions
	* Registers
		* `r0`, `r13`, `r14`, `r15` are highlighted separately
	* Numbers
	* Comments
	* Line Numbers
	* Matching `pushr` / `popr` pairs
* Code Validation
	* Missing/Incorrect Line Numbers
	* Invalid Instruction
	* Invalid operands
		* Invalid Register
		* Invalid Number
		* Missing Operand
		* Extra Operands
* Quick Fixes
	* Incorrect/Missing Line Numbers
	* Extra Operands
* Code Completion
	* Line Numbers
	* Instructions
		* Show instruction signature, assembly, and description
	* Registers
* Goto Definition (Goto destination of jump)
* Find All References (Find all jumps to line)
* Hovers
	* Instruction/Register Descriptions
* Formatting
* Build Code (Compile to binary)

### Debugger Features
* Step Back/Reverse
* Pause
* Step In (Jump past call)
* Step Out (Jump past return [`jumpr`])
* Goto
* Breakpoints
* Data Breakpoints (Break when memory or register is read/written)
* Stack Trace
	* View machine state at each frame
	* Restart execution from frame
* View and edit registers and memory
	* View as Hex, Decimal (Signed & Unsigned), Binary, or HMMM Assembly
	* View whether memory has been modified
* Exceptions
	* Invalid Instructions/Memory accesses
	* Code Segment Accesses

## Known Issues

- Many HMMM instructions have associated aliases or binary encodings which are synonymous with other instructions. Several parts of this extension attempt to disassemble compiled HMMM code and cannot differentiate between these synonymous instructions. In these cases, the extension will attempt to "guess" the most common disassembly. The disassembled instructions will always have a meaning synonymous with the original instruction even if they are not the same.

*For more up-to-date information, see the [issues page](https://github.com/CoolSpy3/hmmm-language-support/issues).*
