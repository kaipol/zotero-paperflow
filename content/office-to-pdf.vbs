Option Explicit

Dim sourcePath, outputPath, extension
Dim app, document, picture, applicationKind
Dim resultExitCode, resultError
Set app = Nothing
Set document = Nothing
Set picture = Nothing
resultExitCode = 0
resultError = ""

If WScript.Arguments.Count <> 2 Then Fail "Expected input and output paths."
sourcePath = WScript.Arguments(0)
outputPath = WScript.Arguments(1)
extension = LCase(Mid(sourcePath, InStrRev(sourcePath, ".") + 1))

On Error Resume Next
Select Case extension
  Case "doc", "docx", "rtf", "txt", "htm", "html", "xml", "odt"
    ConvertWithWord False
  Case "tif", "tiff", "jpg", "jpeg", "png", "bmp", "svg"
    ConvertWithWord True
  Case "xls", "xlsx", "csv", "ods"
    ConvertWithExcel
  Case "ppt", "pptx", "odp"
    ConvertWithPowerPoint
  Case Else
    Fail "Unsupported file type: ." & extension
End Select

If Not document Is Nothing Then CloseOfficeDocument
If Not app Is Nothing Then QuitOffice
If resultExitCode <> 0 Then
  WScript.Echo resultError
  WScript.Quit resultExitCode
End If
WScript.Quit 0

Sub ConvertWithWord(imageOnly)
  On Error Resume Next
  Set app = CreateObject("Word.Application")
  applicationKind = "Word"
  CheckError "Could not start Microsoft Word"
  app.Visible = False
  app.DisplayAlerts = 0
  app.AutomationSecurity = 3
  app.Options.UpdateLinksAtOpen = False
  CheckError "Could not configure Microsoft Word security"

  If imageOnly Then
    Set document = app.Documents.Add()
    CheckError "Could not create a Word document for the image"
    Set picture = document.InlineShapes.AddPicture(sourcePath, False, True)
    CheckError "Microsoft Word could not open the image"
    picture.LockAspectRatio = -1
    If picture.Width > document.PageSetup.PageWidth - document.PageSetup.LeftMargin - document.PageSetup.RightMargin Then
      picture.Width = document.PageSetup.PageWidth - document.PageSetup.LeftMargin - document.PageSetup.RightMargin
    End If
  Else
    Set document = app.Documents.Open(sourcePath, False, True, False)
    CheckError "Microsoft Word could not open the document"
  End If
  document.ExportAsFixedFormat outputPath, 17, False
  CheckError "Microsoft Word could not export the PDF"
End Sub

Sub ConvertWithExcel()
  On Error Resume Next
  Set app = CreateObject("Excel.Application")
  applicationKind = "Excel"
  CheckError "Could not start Microsoft Excel"
  app.Visible = False
  app.DisplayAlerts = False
  app.AutomationSecurity = 3
  app.EnableEvents = False
  CheckError "Could not configure Microsoft Excel security"

  Set document = app.Workbooks.Open(sourcePath, 0, True)
  CheckError "Microsoft Excel could not open the workbook"
  document.ExportAsFixedFormat 0, outputPath
  CheckError "Microsoft Excel could not export the PDF"
End Sub

Sub ConvertWithPowerPoint()
  On Error Resume Next
  Set app = CreateObject("PowerPoint.Application")
  applicationKind = "PowerPoint"
  CheckError "Could not start Microsoft PowerPoint"
  app.Visible = True
  app.DisplayAlerts = 1
  app.AutomationSecurity = 3
  CheckError "Could not configure Microsoft PowerPoint security"

  Set document = app.Presentations.Open(sourcePath, True, False, False)
  CheckError "Microsoft PowerPoint could not open the presentation"
  document.SaveAs outputPath, 32
  CheckError "Microsoft PowerPoint could not export the PDF"
End Sub

Sub CheckError(stage)
  If Err.Number <> 0 Then
    Dim detail
    detail = Err.Description
    Err.Clear
    Fail stage & ": " & detail
  End If
End Sub

Sub CloseOfficeDocument()
  On Error Resume Next
  If applicationKind = "PowerPoint" Then
    document.Close
  Else
    document.Close False
  End If
  If Err.Number <> 0 Then
    Fail "Could not close the Microsoft Office document: " & Err.Description
  End If
  Set document = Nothing
End Sub

Sub QuitOffice()
  On Error Resume Next
  app.Quit
  If Err.Number <> 0 Then
    Fail "Could not quit the Microsoft Office application: " & Err.Description
  End If
  Set app = Nothing
End Sub

Sub Fail(message)
  resultExitCode = 1
  resultError = message
  On Error Resume Next
  If Not document Is Nothing Then document.Close False
  Set document = Nothing
  If Not app Is Nothing Then app.Quit
  Set app = Nothing
  Err.Clear
  WScript.Echo resultError
  WScript.Quit resultExitCode
End Sub
