# HMMM Language Support Documentation
This is the documentation for the HMMM Language Support extension for Visual Studio Code. This extension provides syntax highlighting and debugging support for HMMM assembly and HMMM binary files. What follows is a detailed description of the features of this extension.

Throughout this guide, I will list the keyboard shortcuts for various features. These shortcuts are based on my (I think) default VSCode keybindings on Windows. Your keybindings may differ.

## Editor Features
By default, the extension associates the `.hmmm` and `.hb` file extensions with the HMMM assembly and HMMM binary languages respectively. To change the language in a specific file, click on the language indicator in the bottom right corner of the editor and select the language you want to use. Alternatively, you can press `Ctrl+K M` to open the language selection menu.

### HMMM Assembly

#### Syntax Highlighting
The HMMM Language Support extension provides syntax highlighting for HMMM assembly files. This includes highlighting for instructions, registers, numbers, comments, line numbers, and pushr/popr instructions. Additionally, the registers `r0`, `r13`, `r14`, and `r15` are highlighted differently to indicate that they have special uses in HMMM conventions (or in the case of `r0`, the HMMM language itself). The extension also highlights corresponding pairs of `pushr` and `popr` instructions.

#### Code Validation
The extension will attempt to validate code in HMMM assembly files. This includes checking for missing or incorrect line numbers, invalid instructions, and invalid operands for each instruction. Additionally, the extension will attempt to suggest fixes for errors that it finds.

A full list of errors and fixes that the extension can provide is listed below:

##### Errors
* **Invalid Line** - The extension cannot interpret the line as HMMM code. The extension is designed to be able to handle most common errors, so it is unlikely that you will encounter this error.
	* *No quick fixes provided*
* **Missing Line Number** - The line is missing a line number. All lines in HMMM assembly must have a line number.
	* *Quick Fix*: Add a line number to the line. (The extension will suggest the line number which corresponds to the number of code lines above the line in the file.)
* **Incorrect Line Number** - The line number does not match the expected number of the line.
	* *Quick Fix*: Change the line number to the expected number.
* **Line Number Out of Range** - The line number is outside of the range of line numbers which can be represented in HMMM binary (0-255). Programs with greater than 256 lines are not supported by the HMMM language.
	* *No quick fixes provided*
* **Missing Instruction** - The line is missing an instruction.
	* *No quick fixes provided*
* **Unknown Instruction** - The instruction is not a valid HMMM instruction.
	* *No quick fixes provided*
* **Invalid Operand** - An operand to an instruction is invalid. This error is emitted when the extension cannot interpret an operand as either a register or a number.
	* *No quick fixes provided*
* **Invalid Register** - An operand to an instruction is a register that is above r15 (r16+) rather than a valid HMMM register (r0-r15).
	* *No quick fixes provided*
* **Invalid Number** - An operand to an instruction is a number that is outside the range of numbers which can be represented in HMMM binary (-128-255)
	* *No quick fixes provided*
* **Invalid Operand Type** - One of the operands to an instruction is of the wrong type. Either a register was provided instead of a number or vice versa. Alternatively, the instruction requires a number, but the provided number is not in the range of numbers which the instruction accepts (-128-127 for signed numbers and 0-255 for unsigned numbers).
	* *No quick fixes provided*
* **Missing Operand** - An instruction is missing an operand.
	* *No quick fixes provided*
* **Extra Operand** - An instruction has more operands than it should.
	* *Quick Fix*: Remove the extra operand(s) from the instruction.
* **Unexpected Token** - The extension encountered more tokens than should be on a line (more than 3 instruction arguments).
	* *Quick Fix*: Remove the extra token(s) from the line.
* **Jump destination is outside of code segment (*warning*)** - The extension encountered a jump or call instruction which jumps to a line outside of the code segment. For most HMMM code, this is an error, but there are some cases (in self-modifying code) where this is intentional.
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

## Debugging Features

If you are not familiar with debugging code in VSCode, it is recommended that you read the [VSCode Debugging Documentation](https://code.visualstudio.com/docs/editor/debugging). If you are already familiar with debugging in VSCode, and would like to get started with debugging HMMM code, the main thing to know is that this extension **implements all common features of the VSCode debugging interface**. (The one exception is that there is no way to enter the `Run (Start Without Debugging)` mode.)

This means that you can use most of the same keybindings and commands that you would use when debugging any other language in VSCode. A more detailed description of the features provided by this extension is below.

### Starting the Debugger
The extension also provides debugging support for HMMM assembly and binary files. To launch the debugger, create a launch configuration (see below), open a HMMM assembly or binary file, and press `F5`. This will open the debug view and start the debugger. (Alternatively, you may also goto `Run > Start Debugging`.)

#### Creating an automatic launch configuration
To create an automatic launch configuration (which should be suitable for most projects), go to the `Run and Debug` view and click on `create a launch.json file`. Then select `HMMM Debug`.

By default, the debugger will attempt to run the currently open file as a HMMM assembly file. This should be the most common use case. If you wish to debug a HMMM binary file, you must go to the `Run and Debug` view and change the configuration to `Debug HMMM (Binary)` (You may have to attempt to run the file once to get the menu to show up.)

#### Creating a manual launch configuration
Alternatively, you can also create a VSCode launch configuration to debug HMMM files. The basic syntax for a launch configuration is:
``` jsonc
{
	// Identifies the HMMM debugger (Required)
	"type": "hmmm",
	// Identifies the type of launch (at the moment, only "launch" is supported) (Required)
	"request": "launch",
	// The name of the launch configuration in the UI (you can change this to whatever you want) (Required)
	"name": "Debug HMMM",
	// The path to the file to debug (I *think* relative to the workspace root) (Required)
	"program": "${file}", // ${file} is the path to the currently open file
	// Set to true if you want to debug a HMMM binary file (Optional; If not provided, defaults to false)
	"binary": false
}
```

### Debugger Features

#### Handling of `read` and `write` instructions

##### `read`
When the debugger encounters a `read` instruction, it will prompt the user to enter a value. All values are interpreted in base-10. If the user enters a non-numerical value, the debugger will halt execution. If the user enters a value that is outside the range of numbers which can be represented in HMMM binary (-128-255), the number's high-order bits will be truncated.

##### `write`
When the debugger encounters a `write` instruction, it will print the value of the register or memory location to the debug console in base-10. To view the debug console (if it is not already open) goto `View > Debug Console` or press `Ctrl+Shift+Y`.

#### Debug Actions
See the [Debug Actions section of the VSCode Debugging Documentation](https://code.visualstudio.com/docs/editor/debugging#_debug-actions) for more information on how to use these features.

In addition to the features documented in the VSCode Debugging Documentation, the HMMM debugger also adds two more buttons to the debug toolbar:
* **Step Back** - This will step backwards one instruction
* **Reverse** - This will reverse the execution of the program until the next breakpoint or until the beginning of the program is reached

(These features have some additional limitations which are not present on the other features. See the [Limitations on **Step Back** and **Reverse** section](#limitations-on-step-back-and-reverse) for more information.)

Because functions are not as well defined as functions in other languages, the behavior of the **Step Into** and **Step Out** features is slightly different than in other languages.

The **Step Into** feature will execute until the program executes a `calln` instruction. *After* the `calln` instruction has been executed, the debugger will stop and allow the user to continue stepping through the program.

The **Step Out** feature will execute until the program executes a `jumpr` instruction. *After* the `jumpr` instruction has been executed, the debugger will stop and allow the user to continue stepping through the program.

Note that both of these features will execute the `calln` or `jumpr` instruction before stopping. This is in contrast to breakpoints, where the instruction is *not* executed before the debugger stops.

Whenever the debugger stops, it will highlight the *next* instruction that will be executed if the debugger continues forward. This is true for both forward and reverse execution. A side effect of this is that during forward execution, the highlighted instruction will be executed next, but during reverse execution, the highlighted instruction will be the instruction that was just "undone".

If the memory address of the instruction does not correspond to a line in the source file, no line will be highlighted.

##### Goto
The user can force the debugger to goto a specific line by right clicking on the line and selecting `Jump to Cursor` while the program is paused. This will cause the runtime to jump to the selected line (creating a [stack frame](#the-call-stack) in the process).

##### Limitations on **Step Back** and **Reverse**
Because instructions in HMMM can overwrite the values of registers and memory as well as modify the code of the program, the **Step Back** and **Reverse** features are not as robust as the other execution features.

They both rely on a stack which is internally known as the Instruction Log to store the state of the program at each instruction (This is a stack in the sense that it is a stack data structure. When the "stack" is referenced in other parts of this documentation, it is referring to the [Call Stack](#the-call-stack) not the Instruction log.)

Because certain programs such as infinite loops can cause the instruction log to grow very large, the instruction log is (by default) limited to two million entries. This means that execution can only be reversed for two million instructions. If the instruction log grows larger than this, the debugger will print a warning, *but will not stop execution*. The debugger will then begin to discard the oldest entries in the instruction log as new ones are added. As are result, the program will no longer be able to be reversed to the beginning of the program. (An instruction log entry is also created when a [goto](#goto) is executed.)

This limit can be changed by setting the `hmmm.debugging.reverseExecutionDepth` setting to a different value. Setting this value to `0` or a negative number will remove the limit entirely. (Note that this may cause the debugger to run out of memory if the program executes for long enough and is not recommended.)

Alternatively, the instruction log can be disabled by setting the `hmmm.debugging.enableReverseExecution` setting to `false`. This will disable the **Step Back** and **Reverse** features.

#### Breakpoints
See the [Breakpoints section of the VSCode Debugging Documentation](https://code.visualstudio.com/docs/editor/debugging#_breakpoints) for more information on how to use these features.

Conditional breakpoints and logpoints are not currently supported.

#### The Call Stack
The call stack is shown at the bottom of the debug view when the program is paused. A new stack frame is created whenever a jump is taken (this includes all jump instructions such as `jeqzn` as well as `calln`) as well as whenever a [goto](#goto) is executed. A stack frame is not created when a jump is not taken. For example, in the following code, because the conditional jump to instruction 3 is not taken, no stack frames are created:
``` hmmm
0 setn  r1 1
1 jeqzn r1 3
2 halt
3 write r1
4 halt
```

Each stack frame is labeled with the decompiled form of the instruction that created it. Selecting a stack frame will switch the variables and watch view to showing the values of all registers and memory locations at the time the frame was created. Additionally, the user can [restart](#restarting-stack-frames) execution from a stack frame. If the memory address of the instruction that created the stack frame corresponds to a line in the source file, that line will also be highlighted.

Similar to the [Instruction Log](#limitations-on-step-back-and-reverse), the call stack can grow very large in programs which have a lot of jumps (such as infinite loops). However because each frame contains enough data to restore the machine state (see [Restarting Frames](#restarting-stack-frames)) rather than just a single instruction, the call stack is (by default) limited to only five hundred thousand frames by default. If the call stack grows larger than this, the debugger will print a warning, *but will not stop execution*. The debugger will then begin to discard the oldest frames in the call stack as new ones are added.

This limit can be changed by setting the `hmmm.debugging.stackFrameDepth` setting to a different value. Setting this value to `0` or a negative number will remove the limit entirely. (Note that this may cause the debugger to run out of memory if the program executes for long enough and is not recommended.)

Alternatively, the call stack can be disabled by setting the `hmmm.debugging.enableStackFrames` setting to false.

The top stack frame represents the current instruction. This is true regardless of whether the call stack has been disabled. This is because it is just a representation of the current place in the program Unlike other stack frames, the current stack frame cannot be restarted.

##### Restarting Stack Frames
The user can restart execution from a stack frame by right clicking on the frame and selecting `Restart` from the context menu. Alternatively, the user can press the restart button next to the frame in the call stack view. (Appears when you hover over the frame. Looks like a set of horizontal bars with a circular arrow.)

When a stack frame is restarted, the debugger will restore the machine state to the state it was in just before the frame was created. i.e. Just before the jump was taken, such that the jump instruction is highlighted. Because the jump instruction is now the "next" instruction to be executed, it will will be placed on the top of the displayed call stack. This will make it look like the restarted stack frame has been moved to the top of the stack.

#### Variables
In the variables view, the user can view the values of all registers and memory locations. Most of these can be expanded to view the value in several different representations (decimal, hexadecimal, binary, and interpreted as a HMMM instruction). Memory locations also have a "modified" field which shows whether the value of the memory location has been modified since the start of the program.

The "names" of memory addresses are shown in base 10.

In addition to the registers and memory locations, the variables view also contains a `pc` variable which shows the value of the program counter (instruction pointer) and a `ir` variable which shows the value of the instruction register (the currently highlighted instruction).

##### Hovers
When the user hovers over a register or memory location in the source code, the extension will show the value of the register or memory location along with the various representations of the value.

##### Modifying Variables

The user can edit the values of (most) registers and memory locations (the exceptions are the `pc`, `ir`, and `r0`) by double clicking on the value and entering a new value.

New values can be entered in decimal, hexadecimal, or binary. Negative numbers can only be entered in decimal. If you want to enter a negative number in hexadecimal or binary, you must enter the two's complement representation of the number.

The following logic is used to determine the base of the number:
* If the number starts with `0x`, it is interpreted as hexadecimal
* If the number contains letters, it is interpreted as hexadecimal
* If the number starts with `0b`, it is interpreted as binary
* If the number contains only `0`s and `1`s and is larger than 6 digits, it is interpreted as binary
* If the number is negative, it is interpreted as decimal
* If the number is entered into one of the "representation" fields, it is interpreted as the base of that field
* Otherwise, the number is interpreted as decimal

Values which are longer than 16 bits will have their high-order bits truncated.

#### Watch Expressions
The user can also view the values of specific registers and memory locations in the watch view. Names are case-insensitive and can be any of the names shown in the variables view. Additionally, the user can enter a base-10 number to view the value of a specific memory location.

#### Data Breakpoints
The user can set data breakpoints on all registers and memory locations (except `pc`, `ir`, and `r0`). To set a data breakpoint, right-click on the register or memory location in the variables view and select `Break on Value Read`, `Break on Value Change`, or `Break on Value Access`. (You must click on variable itself. Clicking on one of the representations will not work.)

* **Break on Value Read** - The debugger will pause execution when it encounters an instruction will read the value of the register or memory location is read. (This does not include memory address reads resulting from loading the instruction from memory.)
* **Break on Value Change** - The debugger will pause execution when it encounters an instruction which will change the value of the register or memory location.
* **Break on Value Access** - The debugger will pause execution when it encounters an instruction which will either read or change the value of the register or memory location.

#### Exceptions
The debugger provides several "exceptions" which will be thrown when it encounters problems (or potential problems) with the program.

Each exception is classified as either "Critical" or "Non-Critical". An exception is considered critical if the debugger cannot recover from it. By contrast, a non-critical exception represents a likely-error that can be ignored.

When an exception is thrown, the debugger will pause execution, highlight the instruction that caused the exception, and show a message describing the exception. The user can then inspect the machine state to determine what caused the error. (They can also use the [variables view](#modifying-variables) to modify the machine state and resolve the error, but ultimately, the bug should be fixed in code.) In the case of non-critical exceptions, the user can choose to ignore the exception by pressing the "Continue" button in the [debug toolbar](#debug-actions).

Each exception can be enabled or disabled individually. If a non-critical exception is encountered while it is disabled, the debugger will ignore the exception and continue execution. If a critical exception is encountered while it is disabled, the debugger will print an error to the [debug console](#write) and halt execution.

Exception List:
| Exception | Critical? | Description |
| --- | --- | --- |
| **Invalid Instruction** | Yes | The program attempted to execute a memory address that contains an invalid HMMM instruction. |
| **Invalid Memory Access** | Yes | An instruction attempted to access a memory address that does not exist. |
| **Code Segment Read** | No | An instruction attempted to read from the code segment. |
| **Code Segment Write** | No | An instruction attempted to write to the code segment. |
| **Execute Outside Code Segment** | No | The program attempted to execute an instruction that is outside of the code segment. |

In case you are not familiar with the term, the code segment is the part of memory which contains the program's instructions. In HMMM, the code segment should only refer to the instructions loaded from the source code. There are use cases where the code segment must be read or modified, and instructions outside the code segment must be executed (such as in self-modifying code), but for most HMMM programs, these actions should be considered errors.

## Building Code
The extension provides the ability to build HMMM binary files from HMMM assembly files. This can be accessed by accessing the Command Palette (`Ctrl+Shift+P`) and selecting `HMMM: Build Program`. This will attempt to build the currently open file. The user will be prompted to select a location to save the file.
