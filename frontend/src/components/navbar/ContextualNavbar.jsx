import { useState, useRef, useEffect } from 'react'
import {
  Edit3, Share2, User, UserPlus,
  X, MousePointer2, Pencil, Type, Star, Trash2, Image, ImagePlus, MoreHorizontal, HelpCircle, Globe,
  ArrowUpToLine, ArrowDownToLine,
} from 'lucide-react'
import NavButton from './NavButton'
import AvatarMenu from './AvatarMenu'
import LanguageSwitch from './LanguageSwitch'
import DrawingOptions from '../annotations/DrawingOptions'
import TextOptions from '../annotations/TextOptions'
import StickerPicker from '../annotations/StickerPicker'
import { toJourneyRole, toOpaqueTreeId, trackAppEvent } from '../../utils/analytics'
import { t } from '../../i18n/index.js'
import './ContextualNavbar.css'

const ANNOT_TOOLS = [
  { id: 'pointer', label: t('Sélection'), Icon: MousePointer2 },
  { id: 'drawing', label: t('Dessin'), Icon: Pencil },
  { id: 'text', label: t('Texte'), Icon: Type },
  { id: 'sticker', label: t('Sticker'), Icon: Star },
  { id: 'photo', label: t('Photo'), Icon: Image },
]

function ContextualNavbar({
  userRole,
  pendingContributions = 0,
  editModeActive = false,
  trees = [],
  activeTreeId = null,
  userDisplayName = '',
  userEmail = '',
  userAvatarPhoto = '',
  linkedPersonName = '',
  activeTreeName = '',
  onEditClick,
  onAddPersonClick,
  onAddSouvenirClick,
  helpUrl = '',
  onShareClick,
  onTreeSelect,
  onCreateTree,
  onProfileClick,
  onAccountClick,
  onSettingsClick,
  onLogout,
  annotationTools = null,
  viewMode = 'descendance',
  onViewModeChange = null,
}) {
  const [avatarMenuOpen, setAvatarMenuOpen] = useState(false)
  const [annotPanel, setAnnotPanel] = useState(null)
  const [moreOpen, setMoreOpen] = useState(false)
  const moreRef = useRef(null)
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches
  )

  const avatarMenuRef = useRef(null)
  const navRef = useRef(null)
  const photoInputRef = useRef(null)

  useEffect(() => {
    const mql = window.matchMedia('(max-width: 768px)')
    const handler = (event) => setIsMobile(event.matches)
    mql.addEventListener('change', handler)
    return () => mql.removeEventListener('change', handler)
  }, [])

  useEffect(() => {
    function handleClickOutside(event) {
      if (avatarMenuRef.current && !avatarMenuRef.current.contains(event.target)) {
        setAvatarMenuOpen(false)
      }
      if (moreRef.current && !moreRef.current.contains(event.target)) {
        setMoreOpen(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  useEffect(() => {
    if (!annotPanel) return
    function handleClick(event) {
      if (navRef.current && navRef.current.contains(event.target)) return
      setAnnotPanel(null)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [annotPanel])

  useEffect(() => {
    function handleEscape(event) {
      if (event.key === 'Escape') {
        setAvatarMenuOpen(false)
        setMoreOpen(false)
        setAnnotPanel(null)
      }
    }

    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [])

  useEffect(() => {
    if (!editModeActive) setAnnotPanel(null)
  }, [editModeActive])

  const { navbarType, authenticated } = userRole
  const showMobileAnnot = isMobile && editModeActive && annotationTools
  const accountRole = toJourneyRole(userRole.role) || 'visitor'
  const accountClickProps = {
    role: accountRole,
    tree_id: toOpaqueTreeId(activeTreeId),
  }

  // Création de compte dans l'app
  const handleCreateAccountClick = () => {
    trackAppEvent('create_account_clicked', accountClickProps)
    onProfileClick?.('register')
  }

  const handleAnnotToolClick = (toolId) => {
    annotationTools.onToolChange(toolId)
    if (toolId === 'photo') {
      setAnnotPanel(null)
      photoInputRef.current?.click()
    } else if (['drawing', 'text', 'sticker'].includes(toolId)) {
      setAnnotPanel((prev) => (prev === toolId ? null : toolId))
    } else {
      setAnnotPanel(null)
    }
  }

  // Famille arrivée par le lien : les deux gestes utiles écrits en toutes lettres, le reste dans « Plus »
  const isFamily = (navbarType === 'contributor_anon' || navbarType === 'contributor_auth') && Boolean(onAddSouvenirClick)

  // Sélecteur de mode d'affichage : descendance (arbre entier) ou ascendance (ancêtres de la racine)
  const renderViewModeSwitch = () => (
    <div className="nav-mode-switch" role="group" aria-label={t('Mode d’affichage')}>
      <NavButton
        icon={<ArrowDownToLine size={20} strokeWidth={2} aria-hidden="true" />}
        label={t('Mode descendance')}
        onClick={() => onViewModeChange?.('descendance')}
        active={viewMode === 'descendance'}
      />
      <NavButton
        icon={<ArrowUpToLine size={20} strokeWidth={2} aria-hidden="true" />}
        label={t('Mode ascendance')}
        onClick={() => onViewModeChange?.('ascendance')}
        active={viewMode === 'ascendance'}
      />
    </div>
  )

  const renderFamilyButtons = () => (
    <>
      <button type="button" className="nav-family-btn nav-family-btn--primary" onClick={onAddSouvenirClick}>
        <ImagePlus size={20} strokeWidth={2} aria-hidden="true" />
        <span>{t('Ajouter un souvenir')}</span>
      </button>
      <button type="button" className="nav-family-btn" onClick={onAddPersonClick}>
        <UserPlus size={20} strokeWidth={2} aria-hidden="true" />
        <span>{t('Ajouter une personne')}</span>
      </button>
      <div ref={moreRef} className="nav-more-wrapper">
        <button type="button" className={`nav-family-btn nav-family-btn--more${moreOpen ? ' is-open' : ''}`} onClick={() => setMoreOpen((v) => !v)} aria-expanded={moreOpen} aria-haspopup="menu">
          <MoreHorizontal size={20} strokeWidth={2} aria-hidden="true" />
          <span>{t('Plus')}</span>
        </button>
        {moreOpen && (
          <div className="nav-more-menu" role="menu">
            <button type="button" role="menuitem" onClick={() => { setMoreOpen(false); onEditClick?.() }}>
              <Pencil size={18} strokeWidth={2} aria-hidden="true" />
              {t("Dessiner ou écrire sur l'arbre")}
            </button>
            {onViewModeChange && (
              <button type="button" role="menuitem" onClick={() => { setMoreOpen(false); onViewModeChange(viewMode === 'ascendance' ? 'descendance' : 'ascendance') }}>
                {viewMode === 'ascendance'
                  ? <ArrowDownToLine size={18} strokeWidth={2} aria-hidden="true" />
                  : <ArrowUpToLine size={18} strokeWidth={2} aria-hidden="true" />}
                {viewMode === 'ascendance' ? t('Mode descendance') : t('Mode ascendance')}
              </button>
            )}
            {helpUrl && (
              <a role="menuitem" href={helpUrl} target="_blank" rel="noopener" onClick={() => setMoreOpen(false)}>
                <HelpCircle size={18} strokeWidth={2} aria-hidden="true" />
                {t("Le mode d'emploi")}
              </a>
            )}
            {!authenticated && (
              <button type="button" role="menuitem" onClick={() => { setMoreOpen(false); handleCreateAccountClick() }}>
                <User size={18} strokeWidth={2} aria-hidden="true" />
                {t('Créer un compte')}
              </button>
            )}
            {!authenticated && (
              <div className="pz-lang-row">
                <span className="pz-lang-row-label">
                  <Globe size={18} strokeWidth={2} aria-hidden="true" />
                  <span>{t('Langue')}</span>
                </span>
                <LanguageSwitch />
              </div>
            )}
          </div>
        )}
      </div>
    </>
  )

  const renderButtons = () => {
    switch (navbarType) {
      case 'admin':
        return (
          <>
            <NavButton
              icon={<Edit3 size={20} strokeWidth={2} />}
              label={t("Modifier l'arbre")}
              onClick={onEditClick}
              active={editModeActive}
            />
            {editModeActive && (
              <NavButton
                icon={<UserPlus size={20} strokeWidth={2} />}
                label={t('Ajouter une personne')}
                onClick={onAddPersonClick}
              />
            )}
            <NavButton
              icon={<Share2 size={20} strokeWidth={2} />}
              label={t('Contributions')}
              onClick={onShareClick}
              badge={pendingContributions}
              badgeColor={pendingContributions > 0 ? 'orange' : null}
            />
          </>
        )

      case 'contributor_auth':
        return (
          <>
            <NavButton
              icon={<Edit3 size={20} strokeWidth={2} />}
              label={t('Contribuer')}
              onClick={onEditClick}
              active={editModeActive}
            />
            {editModeActive && (
              <NavButton
                icon={<UserPlus size={20} strokeWidth={2} />}
                label={t('Ajouter une personne')}
                onClick={onAddPersonClick}
              />
            )}
          </>
        )

      case 'contributor_anon':
        return (
          <>
            <NavButton
              icon={<Edit3 size={20} strokeWidth={2} />}
              label={t("Contribuer à l'arbre")}
              onClick={onEditClick}
              active={editModeActive}
            />
            {editModeActive && (
              <NavButton
                icon={<UserPlus size={20} strokeWidth={2} />}
                label={t('Ajouter une personne')}
                onClick={onAddPersonClick}
              />
            )}
            <NavButton
              icon={<User size={20} strokeWidth={2} />}
              label={t('Créer un compte')}
              onClick={handleCreateAccountClick}
            />
          </>
        )

      case 'visitor':
        return (
          <>
            <NavButton
              icon={<User size={20} strokeWidth={2} />}
              label={t('Créer un compte')}
              onClick={handleCreateAccountClick}
            />
            <NavButton
              icon={<Edit3 size={20} strokeWidth={2} />}
              label={t('Contribuer (mot de passe contribution requis)')}
              onClick={onEditClick}
              disabled
            />
          </>
        )

      default:
        if (userRole.accessMode === 'demo') {
          return (
            <>
              <NavButton
                icon={<Edit3 size={20} strokeWidth={2} />}
                label={t('Modifier la démo')}
                onClick={onEditClick}
                active={editModeActive}
              />
              <NavButton
                icon={<User size={20} strokeWidth={2} />}
                label={authenticated ? t('Mon compte') : t('Se connecter')}
                onClick={() => onProfileClick?.(authenticated ? 'login' : 'register')}
              />
            </>
          )
        }

        return (
          <NavButton
            icon={<User size={20} strokeWidth={2} />}
            label={t('Se connecter')}
            onClick={() => onProfileClick?.('login')}
          />
        )
    }
  }

  const avatarInitial = (linkedPersonName || userDisplayName || userEmail || 'P').trim().charAt(0).toUpperCase()

  return (
    <nav
      ref={navRef}
      className={`contextual-navbar${isFamily && !editModeActive ? ' contextual-navbar--family' : ''}${showMobileAnnot ? ' contextual-navbar--annot-mobile' : ''}${annotationTools?.isDragging ? ' contextual-navbar--dragging' : ''}`}
    >
      {showMobileAnnot && annotPanel && (
        <div className="navbar-annot-panel">
          {annotPanel === 'drawing' && annotationTools.activeTool === 'drawing' && (
            <DrawingOptions
              currentStyle={annotationTools.currentStyle}
              onStyleChange={annotationTools.onStyleChange}
            />
          )}
          {annotPanel === 'text' && annotationTools.activeTool === 'text' && (
            <TextOptions
              currentStyle={annotationTools.currentStyle}
              onStyleChange={annotationTools.onStyleChange}
            />
          )}
          {annotPanel === 'sticker' && annotationTools.activeTool === 'sticker' && (
            <StickerPicker
              selected={annotationTools.selectedSticker}
              onSelect={annotationTools.onStickerSelect}
            />
          )}
        </div>
      )}

      {showMobileAnnot && (
        <input
          ref={photoInputRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file && annotationTools.onPhotoFileSelected) {
              annotationTools.onPhotoFileSelected(file)
            }
            event.target.value = ''
          }}
        />
      )}

      <div className={`navbar-content${showMobileAnnot ? ' navbar-content--annot' : ''}`}>
        {showMobileAnnot ? (
          <>
            <button
              className="nav-annot-exit"
              onClick={onEditClick}
              aria-label={t("Quitter l'édition")}
              title={t("Quitter l'édition")}
            >
              <X size={18} strokeWidth={2.5} />
            </button>

            <div className="nav-annot-sep" />

            {ANNOT_TOOLS.map((tool) => (
              <button
                key={tool.id}
                className={`nav-annot-btn${annotationTools.activeTool === tool.id ? ' nav-annot-btn--active' : ''}${annotPanel === tool.id ? ' nav-annot-btn--panel-open' : ''}`}
                onClick={() => handleAnnotToolClick(tool.id)}
                aria-label={tool.label}
                title={tool.label}
              >
                <tool.Icon size={20} strokeWidth={2} />
              </button>
            ))}

            <div className="nav-annot-sep" />

            <button
              className={`nav-annot-btn nav-annot-btn--trash${annotationTools.isDragging ? ' nav-annot-btn--drag-target' : ''}${annotationTools.isOverTrash ? ' nav-annot-btn--drag-over' : ''}`}
              onClick={annotationTools.onDelete}
              disabled={!annotationTools.selectedAnnotationId && !annotationTools.isDragging}
              aria-label={t('Supprimer')}
              title={t('Supprimer')}
              data-annotation-trash=""
            >
              <Trash2 size={annotationTools.isOverTrash ? 22 : 18} strokeWidth={2} />
            </button>

            <button
              className="nav-annot-btn nav-annot-btn--add"
              onClick={onAddPersonClick}
              aria-label={t('Ajouter une personne')}
              title={t('Ajouter une personne')}
            >
              <UserPlus size={18} strokeWidth={2} />
            </button>
          </>
        ) : (
          <>
            {onViewModeChange && renderViewModeSwitch()}
            {isFamily && !editModeActive ? renderFamilyButtons() : renderButtons()}

            {/* Hors connexion, pas de menu du compte : le choix de la langue vit dans la barre (ou dans « Plus » pour la famille) */}
            {!authenticated && !(isFamily && !editModeActive) && <LanguageSwitch className="pz-lang--nav" />}

            {authenticated && (
              <div ref={avatarMenuRef} className="nav-dropdown-wrapper">
                <div
                  className={`nav-avatar ${userRole.isAdmin ? 'admin' : ''} ${avatarMenuOpen ? 'active' : ''}`}
                  onClick={() => setAvatarMenuOpen(!avatarMenuOpen)}
                  role="button"
                  tabIndex={0}
                  aria-label={t('Menu compte')}
                >
                  {userAvatarPhoto ? (
                    <img className="nav-avatar-photo" src={userAvatarPhoto} alt="" />
                  ) : (
                    <span className="nav-avatar-initial">{avatarInitial}</span>
                  )}
                </div>
                {avatarMenuOpen && (
                  <AvatarMenu
                    userDisplayName={userDisplayName}
                    userEmail={userEmail}
                    linkedPersonName={linkedPersonName}
                    trees={trees}
                    activeTreeId={activeTreeId}
                    activeTreeName={activeTreeName}
                    onAccountClick={() => {
                      onAccountClick?.()
                      setAvatarMenuOpen(false)
                    }}
                    onSelectTree={(treeId) => {
                      onTreeSelect?.(treeId)
                      setAvatarMenuOpen(false)
                    }}
                    onCreateTree={() => {
                      onCreateTree?.()
                      setAvatarMenuOpen(false)
                    }}
                    onSettings={() => {
                      onSettingsClick?.()
                      setAvatarMenuOpen(false)
                    }}
                    onLogout={() => {
                      onLogout?.()
                      setAvatarMenuOpen(false)
                    }}
                  />
                )}
              </div>
            )}
          </>
        )}
      </div>
    </nav>
  )
}

export default ContextualNavbar

