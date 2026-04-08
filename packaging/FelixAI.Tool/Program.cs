using System.ComponentModel;
using System.Diagnostics;

var baseDirectory = AppContext.BaseDirectory;
var cliPath = Path.Combine(baseDirectory, "dist", "cli.js");

if (!File.Exists(cliPath))
{
    Console.Error.WriteLine($"[felixai] Missing bundled CLI at '{cliPath}'.");
    return 1;
}

var nodeExecutable = Environment.GetEnvironmentVariable("FELIXAI_NODE_EXE");
if (string.IsNullOrWhiteSpace(nodeExecutable))
{
    nodeExecutable = "node";
}

var startInfo = new ProcessStartInfo
{
    FileName = nodeExecutable,
    WorkingDirectory = Environment.CurrentDirectory,
    UseShellExecute = false
};

startInfo.ArgumentList.Add(cliPath);
foreach (var arg in args)
{
    startInfo.ArgumentList.Add(arg);
}

try
{
    using var process = Process.Start(startInfo);
    if (process is null)
    {
        Console.Error.WriteLine("[felixai] Failed to start the Node.js process.");
        return 1;
    }

    process.WaitForExit();
    return process.ExitCode;
}
catch (Exception ex) when (ex is Win32Exception or FileNotFoundException)
{
    Console.Error.WriteLine("[felixai] Node.js is required to run FelixAI.");
    Console.Error.WriteLine("[felixai] Install Node.js 18+ and ensure 'node' is on PATH, or set FELIXAI_NODE_EXE.");
    Console.Error.WriteLine($"[felixai] Launcher error: {ex.Message}");
    return 1;
}
