# Change Log

## 2.0.4
- Fix operand type mismatch error messages

## 2.0.3
- Fix a bug where special registers do not show the correct hover text if they are capitalized
- Fix HMMM Binary formatter and semantic highlighting not working on lines with weird spacing
- Fix a bug causing errors to not be reported in HMMM binary files

## 2.0.2
- Fix stack frame length setting description

## 2.0.1
- Fix bug where the language syntax files were not packaged with the extension

## 2.0.0
- Add support for HMMM Binary (`.hb`) files
	- Add semantic highlighting of instructions
	- Show decompiled HMMM code in the editor
	- Highlight invalid instructions
	- Install a formatter for HMMM Binary files
- Increase support for HMMM Assembly (`.hmmm`) files by adding a language server
	- Show autocomplete suggestions for line numbers, instructions, and register arguments
	- Show documentation for instructions in the autocomplete and hover tooltips
		- Show the instruction's description, arguments, and effects
	- Implement "Go to Definition" for jump instructions (you can go to the line number they jump to)
	- Implement "Find all References" for all instructions (you can find all instructions that jump to a particular line number)
	- Highlight incorrect line numbers and invalid instructions/operands
	- Highlight matching pairs of pushr/popr instructions
	- Install a formatter for HMMM Assembly files
- Add a command to compile HMMM Assembly files to HMMM Binary files
- Add a debugger for HMMM and HMMM Binary files
	- Provide default configurations and configuration snippets for debugging the current file
	- Implement all core debugging features (forward and reverse execution of HMMM code, breakpoints, stepping, etc.)
	- Provide access to all registers and memory locations in the debug menu and through code hovers
		- Show the values of registers and memory locations in multiple forms (decimal [signed and unsigned], hexadecimal, binary, HMMM instruction)
		- Allow the user to change the values of registers and memory locations through the debug menu
		- Show whether a memory location has been modified
		- Allow the user to set data breakpoints on registers and memory locations (break when a value is read and/or written to)
	- Provide access to the current line number and instruction in the debug menu
	- Allow the user to jump to a specific line number (potentially skipping over HMMM code)
	- Allow the user to set breakpoints for potentially problematic HMMM code
		- Invalid instructions
		- Attempts to access memory locations outside of the memory range
		- Attempts to access memory locations that are part of the code segment
		- Attempts to execute instructions outside of the code segment
	- Keep track of all jumps that have occurred during execution (the program stack)
		- Allow the user to view the HMMM registers and memory at a previous jump
		- Allow the user to restart execution from before a previous jump
- General bug fixes and improvements

## 1.0.1
- Fix highlighting of negative numbers

## 1.0.0
- Initial release
