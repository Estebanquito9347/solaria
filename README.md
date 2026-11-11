# SolarIA

Aplicación web para monitorear instalaciones solares fotovoltaicas. Permite registrar proyectos y paneles, cargar generación diaria, comparar períodos, llevar fallas y mantenimientos, analizar anomalías y emitir reportes imprimibles con datos CSV.

## Probar la aplicación

Abrí `index.html` en un navegador y elegí **Probar con datos de ejemplo**. El modo de demostración incluye registros simulados, permite usar las funciones de la aplicación y guarda los cambios en el almacenamiento local de ese navegador. No sincroniza datos con otros dispositivos.

## Almacenamiento en Supabase

Para habilitar cuentas y almacenamiento en la nube, ejecutá `schema.sql` en el editor SQL de Supabase y configurá la URL del proyecto y la clave pública `anon` en `config.js`. La aplicación aplica políticas de seguridad por usuario mediante Row Level Security.

## Análisis

El análisis es heurístico, no un modelo predictivo: calcula el Performance Ratio con potencia instalada e irradiancia, y señala generación nula con sol, desvíos robustos y caídas sostenidas. Las recomendaciones orientan inspecciones y no reemplazan una evaluación técnica.

En la carga diaria se puede consultar irradiancia de Open-Meteo por ubicación y fecha. El servicio devuelve radiación diaria en MJ/m²; la aplicación la convierte a kWh/m². Son estimaciones de una grilla meteorológica, no mediciones del inversor ni de una estación local; requieren conexión a internet y el pronóstico cubre hasta 7 días adelante.