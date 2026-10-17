---
name: pc-shortcuts
description: Named keyboard shortcuts on Leon's PC (Windows, Chrome, Slack, Spotify, Outlook, VS Code), short routines that jump straight to a Slack channel or person, a VS Code file or a text in a page, Windows Settings pages and Spotify search. Use before clicking any menu.
---

# Shortcuts, routines and links

`D=/mnt/c/Users/you/PROJECTS/TSRCT/scripts/desk.js`

```
node $D shortcut --name "pestana nueva"          # only the names below; --list prints them all
node $D routine --name "slack ir a" --what "soporte"
node $D settings --page sonido
node $D spotify --query "lo-fi para trabajar"
```

A shortcut brings its program forward by itself (Chrome: a window that is NOT TSRCT) and presses the keys.
Only these names exist: you cannot send other key combinations with `shortcut`. A name marked ASK HIM FIRST
is refused here; ask Leon (RESULTADO ok:false with the question) and he says it by voice.

## Shortcuts
**windows**
- `escritorio` - win+d - he says: mostrame el escritorio / mostra el escritorio
- `minimizar todo` - win+m - he says: minimiza todo / minimizar todo
- `restaurar todo` - win+shift+m - he says: restaura todo / volve a abrir todo
- `vista de tareas` - win+tab - he says: vista de tareas / todas las ventanas
- `portapapeles` - win+v - he says: portapapeles / historial del portapapeles
- `recorte` - win+shift+s - he says: captura de pantalla / recorte de pantalla
- `explorador` - win+e - he says: explorador de archivos / abri el explorador
- `configuracion` - win+i - he says: configuracion de windows / abri la configuracion
- `notificaciones` - win+n - he says: notificaciones de windows / centro de notificaciones
- `ajustes rapidos` - win+a - he says: ajustes rapidos / wifi y bluetooth rapido
- `emojis` - win+period - he says: emojis / panel de emojis
- `administrador de tareas` - ctrl+shift+esc - he says: administrador de tareas / task manager
- `nuevo escritorio virtual` - win+ctrl+d - he says: nuevo escritorio virtual / crea un escritorio virtual
- `escritorio virtual siguiente` - win+ctrl+right - he says: escritorio virtual siguiente / siguiente escritorio
- `escritorio virtual anterior` - win+ctrl+left - he says: escritorio virtual anterior / escritorio anterior
- `cerrar escritorio virtual` - win+ctrl+f4 (ASK HIM FIRST) - he says: cerra este escritorio virtual / cerrar escritorio virtual
- `fijar arriba` - win+ctrl+t (needs PowerToys) - he says: siempre arriba / fijala arriba
- `buscar en windows` - win+s - he says: buscar en windows / busqueda de windows
- `cerrar ventana` - alt+f4 (ASK HIM FIRST) - he says: cerra la ventana / cerrala

**chrome** (never the TSRCT window; it picks another Chrome window)
- `pestana nueva` - ctrl+t - he says: pestana nueva / nueva pestana
- `reabrir pestana` - ctrl+shift+t - he says: reabri la pestana / volve a abrir la pestana
- `cerrar pestana` - ctrl+w - he says: cerra la pestana / cerra esta pestana
- `pestana siguiente` - ctrl+tab - he says: pestana siguiente / siguiente pestana
- `pestana anterior` - ctrl+shift+tab - he says: pestana anterior / volve a la pestana anterior
- `recargar pagina` - f5 - he says: recarga la pagina / refresca la pagina
- `historial` - ctrl+h - he says: historial del navegador / historial de chrome
- `descargas del navegador` - ctrl+j - he says: descargas de chrome / descargas del navegador

**spotify**
- `spotify aleatorio` - ctrl+s - he says: aleatorio / modo aleatorio
- `spotify repetir` - ctrl+r - he says: repeti la cancion / modo repetir

**slack**
- `slack no leidos` - ctrl+shift+a - he says: no leidos de slack / lo que no lei en slack
- `slack mensajes directos` - ctrl+shift+k - he says: mensajes directos de slack / los privados de slack
- `slack menciones` - ctrl+shift+m - he says: menciones de slack / donde me nombraron en slack

**outlook**
- `outlook correo` - ctrl+1 - he says: correo de outlook / bandeja de outlook
- `outlook calendario` - ctrl+2 - he says: calendario de outlook / agenda de outlook

**code**
- `vscode comandos` - ctrl+shift+p - he says: paleta de comandos / comandos de vs code
- `vscode terminal` - ctrl+backtick - he says: terminal de vs code / abri la terminal de code

## Routines (one short name typed into the program they bring forward)
- `slack ir a` (--what = canal o persona) in slack
- `vscode abrir archivo` (--what = nombre de archivo) in code
- `chrome buscar en la pagina` (--what = que buscar) in chrome

Each step checks that the program is still in front; if not, nothing is typed. A routine only opens and
searches, it never sends: after `slack ir a` the chat is open and the message box is empty.

## Windows Settings pages (`settings --page`)
sonido, audio, volumen, parlantes, microfono, pantalla, monitores, resolucion, brillo, escala, bluetooth, auriculares, wifi, internet, red, vpn, notificaciones, no molestar, bateria, energia, suspension, aplicaciones, programas, inicio, apps de inicio, predeterminadas, impresoras, mouse, teclado, idioma, hora, fecha, fondo, colores, modo oscuro, tema, actualizaciones, windows update, almacenamiento, disco, privacidad, camara, cuentas, acerca de, mi pc.
With no page it opens Settings' home.

## Inside a program, when there is no row here
Prefer the program's own keys over the mouse (`node $D key --keys ...` after a look):
Ctrl+F find, Ctrl+L address bar, Ctrl+K quick switcher (Slack, ClickUp, many web apps), Esc close a menu,
Tab / Shift+Tab move between fields, Enter open. If you used the mouse for something a key could do,
put it in "falta" so it becomes a row here.
