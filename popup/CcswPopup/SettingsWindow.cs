using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using WinForms = System.Windows.Forms;

// Tray-menu "Settings..." dialog. Built in code (no .xaml) to match the
// rest of the UI in this project. Only exposes the log folder today; later
// DECONFIG settings should add another labeled row rather than restructure
// this window.
internal sealed class SettingsWindow : Window
{
    private readonly TextBox _logPathBox;

    public SettingsWindow(string currentLogFolder, Func<string, string?> trySave)
    {
        Title = "CcswPopup Settings";
        Width = 480;
        SizeToContent = SizeToContent.Height;
        ResizeMode = ResizeMode.NoResize;
        WindowStartupLocation = WindowStartupLocation.CenterScreen;
        Background = new SolidColorBrush(Color.FromRgb(0x22, 0x22, 0x22));

        var root = new StackPanel { Margin = new Thickness(16) };

        root.Children.Add(new TextBlock
        {
            Text = "Currently logging to:",
            Foreground = Brushes.White,
            FontWeight = FontWeights.Bold,
            Margin = new Thickness(0, 0, 0, 2),
        });
        root.Children.Add(new TextBlock
        {
            Text = currentLogFolder,
            Foreground = Brushes.Gainsboro,
            TextWrapping = TextWrapping.Wrap,
            Margin = new Thickness(0, 0, 0, 16),
        });

        root.Children.Add(new TextBlock
        {
            Text = "Log path",
            Foreground = Brushes.White,
            FontWeight = FontWeights.Bold,
            Margin = new Thickness(0, 0, 0, 4),
        });

        var pathRow = new DockPanel { Margin = new Thickness(0, 0, 0, 16) };
        var browseButton = new Button { Content = "Browse...", Width = 80 };
        DockPanel.SetDock(browseButton, Dock.Right);
        _logPathBox = new TextBox
        {
            Text = currentLogFolder,
            VerticalContentAlignment = VerticalAlignment.Center,
            Margin = new Thickness(0, 0, 8, 0),
        };
        pathRow.Children.Add(browseButton);
        pathRow.Children.Add(_logPathBox);
        root.Children.Add(pathRow);

        browseButton.Click += (_, _) =>
        {
            using var dialog = new WinForms.FolderBrowserDialog
            {
                Description = "Choose where popup.log is written",
                SelectedPath = Directory.Exists(_logPathBox.Text) ? _logPathBox.Text : "",
                ShowNewFolderButton = true,
            };
            if (dialog.ShowDialog() == WinForms.DialogResult.OK)
            {
                _logPathBox.Text = dialog.SelectedPath;
            }
        };

        var buttonRow = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            HorizontalAlignment = HorizontalAlignment.Right,
        };
        var cancelButton = new Button { Content = "Cancel", Width = 80, Margin = new Thickness(0, 0, 8, 0), IsCancel = true };
        var saveButton = new Button { Content = "Save", Width = 80, IsDefault = true };

        cancelButton.Click += (_, _) =>
        {
            DialogResult = false;
            Close();
        };
        saveButton.Click += (_, _) =>
        {
            var error = trySave(_logPathBox.Text.Trim());
            if (error is not null)
            {
                MessageBox.Show(error, "CcswPopup", MessageBoxButton.OK, MessageBoxImage.Warning);
                return;
            }
            DialogResult = true;
            Close();
        };

        buttonRow.Children.Add(cancelButton);
        buttonRow.Children.Add(saveButton);
        root.Children.Add(buttonRow);

        Content = root;
    }
}
