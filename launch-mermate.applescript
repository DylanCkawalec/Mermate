on run
	set portInUse to do shell script "if lsof -ti :3333 >/dev/null 2>&1; then echo yes; else echo no; fi"
	if portInUse is "no" then
		tell application "Terminal"
			activate
			do script "cd \"$HOME/Desktop/developer/mermaid\" && ./start.command"
		end tell
		-- Give server a moment to boot before opening browser
		delay 2
	end if
	do shell script "open http://localhost:3333"
end run
